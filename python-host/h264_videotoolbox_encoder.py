import fractions
import logging
import math
from collections.abc import Iterable, Iterator
from itertools import tee
from struct import pack, unpack_from
from typing import Optional, Type, TypeVar

import av
from av.frame import Frame
from av.packet import Packet
from av.video.codeccontext import VideoCodecContext

from aiortc.codecs import Encoder
from aiortc.mediastreams import VIDEO_TIME_BASE, convert_timebase

logger = logging.getLogger(__name__)

DEFAULT_BITRATE = 3000000  # 3 Mbps
MIN_BITRATE = 500000  # 500 kbps
MAX_BITRATE = 8000000  # 8 Mbps

MAX_FRAME_RATE = 20
PACKET_MAX = 1300
# VideoToolbox buffers 4–6 frames; force_keyframe must wait for that IDR
# instead of reopening the codec (which discards the in-flight IDR).
IDR_WAIT_FRAMES = 8
# Chrome TURN decoder freezes despite 1s IDRs; a new SPS every ~2s
# (the accidental wait-window reopen) was the only 60s-passing recovery.
RELAY_DECODER_REFRESH_FRAMES = 40

NAL_TYPE_IDR = 5
NAL_TYPE_FU_A = 28
NAL_TYPE_STAP_A = 24

_session_gop_size = 40


def set_session_gop_size(gop: int) -> int:
    global _session_gop_size
    _session_gop_size = max(10, min(int(gop), 120))
    return _session_gop_size


def get_session_gop_size() -> int:
    return _session_gop_size


def codec_name_for_gop(gop: int) -> str:
    """Relay GOP (~1s) uses libx264+VBV; VideoToolbox IDRs are too large for TURN."""
    return "libx264" if int(gop or 0) <= 20 else "h264_videotoolbox"


def min_bitrate_bps(gop: int, width: int, height: int) -> int:
    width = int(width or 0)
    height = int(height or 0)
    pixels = max(1, width * height)
    if int(gop or 0) <= 20:
        # Capture may be 1152x720 under a 1280x720 session cap.
        if height >= 1000 or pixels >= 1920 * 1080:
            return 2_500_000
        if height >= 700 or pixels >= 1152 * 720:
            return 1_800_000
        return 1_200_000
    return MIN_BITRATE


def libx264_zerolatency_options(bitrate_bps: int, gop: int) -> dict:
    kbps = max(1, int(bitrate_bps) // 1000)
    # 100ms of bits: 1.8 Mbps → vbv-bufsize=180 kbit (~22KB IDR cap).
    # Standalone vbv-* keys are ignored by PyAV; x264-params is required.
    bufsize = max(120, int(bitrate_bps) // 10000)
    gop_s = str(max(1, int(gop or 20)))
    return {
        "preset": "ultrafast",
        "tune": "zerolatency",
        "x264-params": (
            f"keyint={gop_s}:min-keyint={gop_s}:scenecut=0:bframes=0:"
            f"threads=1:sliced-threads=0:slices=1:sync-lookahead=0:"
            f"rc-lookahead=0:repeat-headers=1:open-gop=0:intra-refresh=0:"
            f"forced-idr=1:vbv-maxrate={kbps}:vbv-bufsize={bufsize}:"
            f"vbv-init=0.4:nal-hrd=none"
        ),
    }


def _nal_is_idr(nal: bytes) -> bool:
    if not nal:
        return False
    nal_type = nal[0] & 0x1F
    if nal_type == NAL_TYPE_IDR:
        return True
    if nal_type == NAL_TYPE_FU_A and len(nal) >= 2:
        return (nal[1] & 0x1F) == NAL_TYPE_IDR
    if nal_type == NAL_TYPE_STAP_A:
        pos = 1
        while pos + 2 <= len(nal):
            length = int.from_bytes(nal[pos:pos + 2], "big")
            pos += 2
            if pos + length > len(nal):
                break
            unit = nal[pos:pos + length]
            pos += length
            if unit and (unit[0] & 0x1F) == NAL_TYPE_IDR:
                return True
    return False


def bitstream_contains_idr(data: bytes) -> bool:
    if not data:
        return False
    # Annex-B and AVCC must not be mixed: payload 0x00000005 0x65 inside a
    # P-slice is not an IDR NAL.
    if data.startswith(b"\x00\x00\x00\x01") or data.startswith(b"\x00\x00\x01"):
        for nal in H264VideoToolboxEncoder._split_bitstream(data):
            if _nal_is_idr(nal):
                return True
        return False
    pos = 0
    scanned = False
    while pos + 4 <= len(data):
        length = int.from_bytes(data[pos:pos + 4], "big")
        pos += 4
        if length <= 0 or pos + length > len(data):
            break
        scanned = True
        if _nal_is_idr(data[pos:pos + length]):
            return True
        pos += length
    if scanned:
        return False
    return _nal_is_idr(data)

NAL_HEADER_SIZE = 1
FU_A_HEADER_SIZE = 2
LENGTH_FIELD_SIZE = 2
STAP_A_HEADER_SIZE = NAL_HEADER_SIZE + LENGTH_FIELD_SIZE

DESCRIPTOR_T = TypeVar("DESCRIPTOR_T", bound="H264PayloadDescriptor")
T = TypeVar("T")


def pairwise(iterable):
    a, b = tee(iterable)
    next(b, None)
    return zip(a, b)


class H264PayloadDescriptor:
    def __init__(self, first_fragment: bool) -> None:
        self.first_fragment = first_fragment

    def __repr__(self) -> str:
        return f"H264PayloadDescriptor(FF={self.first_fragment})"

    @classmethod
    def parse(cls: Type[DESCRIPTOR_T], data: bytes) -> tuple[DESCRIPTOR_T, bytes]:
        output = bytes()

        # NAL unit header
        if len(data) < 2:
            raise ValueError("NAL unit is too short")
        nal_type = data[0] & 0x1F
        f_nri = data[0] & (0x80 | 0x60)
        pos = NAL_HEADER_SIZE

        if nal_type in range(1, 24):
            # single NAL unit
            output = bytes([0, 0, 0, 1]) + data
            obj = cls(first_fragment=True)
        elif nal_type == NAL_TYPE_FU_A:
            # fragmentation unit
            original_nal_type = data[pos] & 0x1F
            first_fragment = bool(data[pos] & 0x80)
            pos += 1

            if first_fragment:
                original_nal_header = bytes([f_nri | original_nal_type])
                output += bytes([0, 0, 0, 1])
                output += original_nal_header
            output += data[pos:]

            obj = cls(first_fragment=first_fragment)
        elif nal_type == NAL_TYPE_STAP_A:
            # single time aggregation packet
            offsets = []
            while pos < len(data):
                if len(data) < pos + LENGTH_FIELD_SIZE:
                    raise ValueError("STAP-A length field is truncated")
                nalu_size = unpack_from("!H", data, pos)[0]
                pos += LENGTH_FIELD_SIZE
                offsets.append(pos)

                pos += nalu_size
                if len(data) < pos:
                    raise ValueError("STAP-A data is truncated")

            offsets.append(len(data) + LENGTH_FIELD_SIZE)
            for start, end in pairwise(offsets):
                end -= LENGTH_FIELD_SIZE
                output += bytes([0, 0, 0, 1])
                output += data[start:end]

            obj = cls(first_fragment=True)
        else:
            raise ValueError(f"NAL unit type {nal_type} is not supported")

        return obj, output


# After the first VideoToolbox open/encode failure in-process, stick to libx264.
# Profile thrash (survival↔low) used to recreate the encoder and re-hit VT every
# few seconds, producing multi-second black/stutter gaps on TURN paths.
_preferred_h264_codec = "h264_videotoolbox"


class H264VideoToolboxEncoder(Encoder):
    def __init__(self) -> None:
        self.buffer_data = b""
        self.buffer_pts: Optional[int] = None
        self.codec: Optional[VideoCodecContext] = None
        self.gop_size = get_session_gop_size()
        self.codec_name = codec_name_for_gop(self.gop_size)
        self.__target_bitrate = 0
        self.last_force_emitted_idr = False
        self.last_idr_recreated = False
        self._idr_wait_remaining = 0
        self._frames_since_idr = 0
        self._frames_encoded = 0

    @staticmethod
    def _packetize_fu_a(data: bytes) -> list[bytes]:
        available_size = PACKET_MAX - FU_A_HEADER_SIZE
        payload_size = len(data) - NAL_HEADER_SIZE
        num_packets = math.ceil(payload_size / available_size)
        num_larger_packets = payload_size % num_packets
        package_size = payload_size // num_packets

        f_nri = data[0] & (0x80 | 0x60)  # fni of original header
        nal = data[0] & 0x1F

        fu_indicator = f_nri | NAL_TYPE_FU_A

        fu_header_end = bytes([fu_indicator, nal | 0x40])
        fu_header_middle = bytes([fu_indicator, nal])
        fu_header_start = bytes([fu_indicator, nal | 0x80])
        fu_header = fu_header_start

        packages = []
        offset = NAL_HEADER_SIZE
        while offset < len(data):
            if num_larger_packets > 0:
                num_larger_packets -= 1
                payload = data[offset : offset + package_size + 1]
                offset += package_size + 1
            else:
                payload = data[offset : offset + package_size]
                offset += package_size

            if offset == len(data):
                fu_header = fu_header_end

            packages.append(fu_header + payload)

            fu_header = fu_header_middle
        assert offset == len(data), "incorrect fragment data"

        return packages

    @staticmethod
    def _packetize_stap_a(
        data: bytes, packages_iterator: Iterator[bytes]
    ) -> tuple[bytes, bytes]:
        counter = 0
        available_size = PACKET_MAX - STAP_A_HEADER_SIZE

        stap_header = NAL_TYPE_STAP_A | (data[0] & 0xE0)

        payload = bytes()
        try:
            nalu = data  # with header
            while len(nalu) <= available_size and counter < 9:
                stap_header |= nalu[0] & 0x80

                nri = nalu[0] & 0x60
                if stap_header & 0x60 < nri:
                    stap_header = stap_header & 0x9F | nri

                available_size -= LENGTH_FIELD_SIZE + len(nalu)
                counter += 1
                payload += pack("!H", len(nalu)) + nalu
                nalu = next(packages_iterator)

            if counter == 0:
                nalu = next(packages_iterator)
        except StopIteration:
            nalu = None

        if counter <= 1:
            return data, nalu
        else:
            return bytes([stap_header]) + payload, nalu

    @staticmethod
    def _split_bitstream(buf: bytes) -> Iterator[bytes]:
        # Translated from: https://github.com/aizvorski/h264bitstream/blob/master/h264_nal.c#L134
        i = 0
        while True:
            # Find the start of the NAL unit.
            #
            # NAL Units start with the 3-byte start code 0x000001 or
            # the 4-byte start code 0x00000001.
            i = buf.find(b"\x00\x00\x01", i)
            if i == -1:
                return

            # Jump past the start code
            i += 3
            nal_start = i

            # Find the end of the NAL unit (end of buffer OR next start code)
            i = buf.find(b"\x00\x00\x01", i)
            if i == -1:
                yield buf[nal_start : len(buf)]
                return
            elif buf[i - 1] == 0:
                # 4-byte start code case, jump back one byte
                yield buf[nal_start : i - 1]
            else:
                yield buf[nal_start:i]

    @classmethod
    def _packetize(cls, packages: Iterable[bytes]) -> list[bytes]:
        packetized_packages = []

        packages_iterator = iter(packages)
        package = next(packages_iterator, None)
        while package is not None:
            if len(package) > PACKET_MAX:
                packetized_packages.extend(cls._packetize_fu_a(package))
                package = next(packages_iterator, None)
            else:
                packetized, package = cls._packetize_stap_a(package, packages_iterator)
                packetized_packages.append(packetized)

        return packetized_packages

    def _encode_frame(
        self, frame: av.VideoFrame, force_keyframe: bool
    ) -> Iterator[bytes]:
        if self.codec and (
            frame.width != self.codec.width
            or frame.height != self.codec.height
        ):
            self.buffer_data = b""
            self.buffer_pts = None
            self.codec = None
            self.last_idr_recreated = False
            self._idr_wait_remaining = 0
            self._frames_since_idr = 0
            self._frames_encoded = 0

        session_gop = get_session_gop_size()
        wanted_codec = codec_name_for_gop(session_gop)
        if self.gop_size in (20, 40) and (
            self.gop_size != session_gop or self.codec_name != wanted_codec
        ):
            self.gop_size = session_gop
            self.codec_name = wanted_codec
            if self.codec is not None:
                self.codec = None
                self.last_idr_recreated = False
                self._idr_wait_remaining = 0
                self._frames_since_idr = 0
                self._frames_encoded = 0

        gop = int(getattr(self, "gop_size", None) or session_gop)
        if (
            gop <= 20
            and self.codec is not None
            and self._frames_encoded > 0
            and self._frames_encoded % RELAY_DECODER_REFRESH_FRAMES == 0
        ):
            self.codec = None
            self.last_idr_recreated = False
            self._idr_wait_remaining = 0
            logger.info(
                "WRD_DECODER_REFRESH encoded=%s gop=%s size=%sx%s",
                self._frames_encoded,
                gop,
                frame.width,
                frame.height,
            )
        # libx264 already emits IDR without a wait-window; waiting would
        # block GOP cadence and then miss delayed type-5 NALs.
        use_wait = self.codec_name != "libx264"
        waiting = use_wait and self._idr_wait_remaining > 0
        # Cadence is encode-count. Bitstream IDR scans can false-positive on
        # P-slice payload and must not skip the 1s relay keyframe.
        due = (not waiting) and (
            bool(force_keyframe)
            or (self._frames_encoded > 0 and self._frames_encoded % max(1, gop) == 0)
        )
        # VideoToolbox ignores codec.gop_size. Submit one I, then wait for
        # the delayed IDR instead of stuffing I-frames every follow-up tick.
        if due:
            frame.pict_type = av.video.frame.PictureType.I
            try:
                frame.key_frame = True
            except Exception:
                pass
        else:
            frame.pict_type = av.video.frame.PictureType.NONE

        if self.codec is None:
            self.codec = self._create_codec(frame, self.codec_name)

        if due:
            self.last_force_emitted_idr = False
            if use_wait:
                self._idr_wait_remaining = IDR_WAIT_FRAMES
                waiting = True

        encoded_packets: list[bytes] = []
        try:
            encoded_packets = [bytes(package) for package in self.codec.encode(frame)]
        except av.FFmpegError as exc:
            if self.codec_name != "libx264":
                global _preferred_h264_codec
                logger.warning("VideoToolbox encode failed, falling back to libx264: %s", exc)
                _preferred_h264_codec = "libx264"
                self.codec_name = "libx264"
                self.codec = self._create_codec(frame, self.codec_name)
                encoded_packets = [bytes(package) for package in self.codec.encode(frame)]
            else:
                raise
        data_to_send = b"".join(encoded_packets)

        recreated_this_call = False
        waiting = self._idr_wait_remaining > 0
        want_idr = due or waiting
        self._frames_encoded += 1
        has_idr = bitstream_contains_idr(data_to_send) or any(
            _nal_is_idr(packet) for packet in encoded_packets
        )
        if has_idr:
            self._frames_since_idr = 0
            self._idr_wait_remaining = 0
            if waiting or want_idr:
                self.last_force_emitted_idr = True
                self.last_idr_recreated = False
                logger.info(
                    "WRD_KEYFRAME requested=true emitted=%s recreated=%s gop=%s size=%dx%d bytes=%s encoded=%s",
                    True,
                    False,
                    getattr(self, "gop_size", get_session_gop_size()),
                    frame.width,
                    frame.height,
                    len(data_to_send),
                    self._frames_encoded,
                )
        elif waiting:
            self._frames_since_idr += 1
            self._idr_wait_remaining -= 1
            if (
                self._idr_wait_remaining <= 0
                and not self.last_idr_recreated
                and self.codec_name != "libx264"
            ):
                self.codec = None
                self.codec = self._create_codec(frame, self.codec_name)
                recreated_this_call = True
                self.last_idr_recreated = True
                data_to_send = b""
                for package in self.codec.encode(frame):
                    data_to_send += bytes(package)
                self.last_force_emitted_idr = bitstream_contains_idr(data_to_send)
                self._idr_wait_remaining = 0 if self.last_force_emitted_idr else IDR_WAIT_FRAMES
                if self.last_force_emitted_idr:
                    self.last_idr_recreated = False
                    self._frames_since_idr = 0
                logger.info(
                    "WRD_KEYFRAME requested=true emitted=%s recreated=%s gop=%s size=%dx%d bytes=%s",
                    self.last_force_emitted_idr,
                    True,
                    getattr(self, "gop_size", get_session_gop_size()),
                    frame.width,
                    frame.height,
                    len(data_to_send),
                )
                logger.info(
                    "WRD_IDR_RECREATE success=%s codec=%s",
                    self.last_force_emitted_idr,
                    self.codec_name,
                )
            elif due:
                logger.info(
                    "WRD_KEYFRAME requested=true emitted=%s recreated=%s gop=%s size=%dx%d bytes=%s",
                    False,
                    False,
                    getattr(self, "gop_size", get_session_gop_size()),
                    frame.width,
                    frame.height,
                    len(data_to_send),
                )
        else:
            self._frames_since_idr += 1

        if data_to_send:
            yield from self._split_bitstream(data_to_send)

    def _create_codec(self, frame: av.VideoFrame, codec_name: str) -> VideoCodecContext:
        gop = int(getattr(self, "gop_size", None) or get_session_gop_size())
        if codec_name_for_gop(gop) == "libx264":
            codec_name = "libx264"
            self.codec_name = "libx264"
        floor = min_bitrate_bps(gop, frame.width, frame.height)
        if self.__target_bitrate and self.__target_bitrate > 0:
            bitrate = int(self.__target_bitrate)
        elif gop <= 20:
            bitrate = floor
        elif frame.width * frame.height <= 1280 * 720:
            bitrate = 2_500_000
        elif frame.width * frame.height <= 1920 * 1080:
            bitrate = 4_000_000
        else:
            bitrate = 6_000_000
        if gop <= 20:
            bitrate = min(bitrate, 2_500_000)
        bitrate = max(floor, min(bitrate, MAX_BITRATE))
        self.__target_bitrate = bitrate

        logger.info(
            "Opening H.264 encoder codec=%s size=%dx%d bitrate=%d gop=%s",
            codec_name,
            frame.width,
            frame.height,
            bitrate,
            gop,
        )
        codec = av.CodecContext.create(codec_name, "w")
        codec.width = frame.width
        codec.height = frame.height
        codec.bit_rate = bitrate
        try:
            codec.rc_max_rate = bitrate
            codec.rc_buffer_size = max(120_000, bitrate // 10)
        except Exception:
            pass
        codec.pix_fmt = "yuv420p"
        codec.framerate = fractions.Fraction(MAX_FRAME_RATE, 1)
        codec.time_base = fractions.Fraction(1, MAX_FRAME_RATE)
        codec.profile = "Baseline"
        codec.gop_size = gop
        try:
            codec.max_b_frames = 0
        except Exception:
            pass
        try:
            from av.codec.context import Flags
            flags = int(codec.flags) | int(Flags.low_delay)
            closed = getattr(Flags, "closed_gop", None)
            if closed is not None:
                flags |= int(closed)
            codec.flags = flags
        except Exception:
            pass
        if codec_name == "libx264":
            codec.options = libx264_zerolatency_options(bitrate, gop)
            logger.info(
                "WRD_ENCODER_X264 params=%s",
                (codec.options or {}).get("x264-params", "-"),
            )
        return codec

    def encode(
        self, frame: Frame, force_keyframe: bool = False
    ) -> tuple[list[bytes], int]:
        assert isinstance(frame, av.VideoFrame)
        packages = self._encode_frame(frame, force_keyframe)
        timestamp = convert_timebase(frame.pts, frame.time_base, VIDEO_TIME_BASE)
        return self._packetize(packages), timestamp

    def pack(self, packet: Packet) -> tuple[list[bytes], int]:
        assert isinstance(packet, av.Packet)
        packages = self._split_bitstream(bytes(packet))
        timestamp = convert_timebase(packet.pts, packet.time_base, VIDEO_TIME_BASE)
        return self._packetize(packages), timestamp

    @property
    def target_bitrate(self) -> int:
        """
        Target bitrate in bits per second.
        """
        return self.__target_bitrate

    @target_bitrate.setter
    def target_bitrate(self, bitrate: int) -> None:
        gop = int(getattr(self, "gop_size", None) or get_session_gop_size())
        width = getattr(self.codec, "width", 1280) if self.codec is not None else 1280
        height = getattr(self.codec, "height", 720) if self.codec is not None else 720
        bitrate = min(int(bitrate), MAX_BITRATE)
        if gop <= 20:
            bitrate = min(bitrate, 2_500_000)
        bitrate = max(min_bitrate_bps(gop, width, height), bitrate)
        self.__target_bitrate = bitrate
        # Hot-update without reopening the codec when size is unchanged.
        if self.codec is not None:
            try:
                self.codec.bit_rate = bitrate
            except Exception as exc:
                logger.debug("hot bitrate update failed: %s", type(exc).__name__)


def h264_depayload(payload: bytes) -> bytes:
    descriptor, data = H264PayloadDescriptor.parse(payload)
    return data
