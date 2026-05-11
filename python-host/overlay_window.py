#!/usr/bin/env python3
"""Small macOS floating status window for WebRemoteDesktop host events."""
import json
import queue
import sys
import threading
import time

from AppKit import (
    NSApp,
    NSApplication,
    NSBackingStoreBuffered,
    NSColor,
    NSFont,
    NSMakeRect,
    NSScreen,
    NSTextField,
    NSTimer,
    NSView,
    NSWindow,
    NSWindowCollectionBehaviorCanJoinAllSpaces,
    NSWindowStyleMaskBorderless,
)
from Foundation import NSObject
import objc


COMMAND_QUEUE = queue.Queue()


class OverlayController(NSObject):
    def init(self):
        self = objc.super(OverlayController, self).init()
        if self is None:
            return None

        self.window = None
        self.container = None
        self.title_label = None
        self.viewer_label = None
        self.key_label = None
        self.last_key_time = 0
        self.online_count = 0
        self.viewers = []
        self.visible = False
        return self

    def applicationDidFinishLaunching_(self, notification):
        self.buildWindow()
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.1, self, "pollQueue:", None, True
        )
        NSTimer.scheduledTimerWithTimeInterval_target_selector_userInfo_repeats_(
            0.08, self, "tickFade:", None, True
        )

    @objc.python_method
    def buildWindow(self):
        screen = NSScreen.mainScreen().visibleFrame()
        width = 360
        height = 132
        margin = 22
        x = screen.origin.x + screen.size.width - width - margin
        y = screen.origin.y + margin

        self.window = NSWindow.alloc().initWithContentRect_styleMask_backing_defer_(
            NSMakeRect(x, y, width, height),
            NSWindowStyleMaskBorderless,
            NSBackingStoreBuffered,
            False,
        )
        self.window.setOpaque_(False)
        self.window.setBackgroundColor_(NSColor.clearColor())
        self.window.setLevel_(1000)
        self.window.setIgnoresMouseEvents_(True)
        self.window.setCollectionBehavior_(NSWindowCollectionBehaviorCanJoinAllSpaces)
        self.window.setAlphaValue_(0.0)

        self.container = NSView.alloc().initWithFrame_(NSMakeRect(0, 0, width, height))
        self.container.setWantsLayer_(True)
        layer = self.container.layer()
        layer.setCornerRadius_(14.0)
        layer.setBackgroundColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(0.05, 0.07, 0.10, 0.90).CGColor())
        layer.setBorderWidth_(1.0)
        layer.setBorderColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(0.35, 0.55, 0.95, 0.35).CGColor())

        self.title_label = self.makeLabel(18, 94, 324, 22, "WebRemoteDesktop", 13, True)
        self.viewer_label = self.makeLabel(18, 58, 324, 30, "等待访问者", 12, False)
        self.key_label = self.makeLabel(18, 22, 324, 24, "键盘：-", 12, False)
        self.key_label.setTextColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(0.55, 0.75, 1.0, 1.0))

        self.container.addSubview_(self.title_label)
        self.container.addSubview_(self.viewer_label)
        self.container.addSubview_(self.key_label)
        self.window.setContentView_(self.container)
        self.window.orderOut_(None)

    @objc.python_method
    def makeLabel(self, x, y, w, h, text, size, bold):
        label = NSTextField.alloc().initWithFrame_(NSMakeRect(x, y, w, h))
        label.setStringValue_(text)
        label.setBezeled_(False)
        label.setDrawsBackground_(False)
        label.setEditable_(False)
        label.setSelectable_(False)
        label.setFont_(NSFont.boldSystemFontOfSize_(size) if bold else NSFont.systemFontOfSize_(size))
        label.setTextColor_(NSColor.colorWithCalibratedRed_green_blue_alpha_(0.92, 0.95, 1.0, 1.0))
        return label

    def pollQueue_(self, timer):
        while True:
            try:
                event = COMMAND_QUEUE.get_nowait()
            except queue.Empty:
                break
            self.handleEvent(event)

    def tickFade_(self, timer):
        if self.online_count > 0:
            if not self.visible:
                self.visible = True
                self.window.makeKeyAndOrderFront_(None)
            current = self.window.alphaValue()
            self.window.setAlphaValue_(min(0.96, current + 0.10))
        else:
            current = self.window.alphaValue()
            next_alpha = max(0.0, current - 0.08)
            self.window.setAlphaValue_(next_alpha)
            if next_alpha <= 0.01 and self.visible:
                self.visible = False
                self.window.orderOut_(None)

        elapsed = time.time() - self.last_key_time
        if elapsed > 2.5 and self.online_count > 0:
            self.key_label.setAlphaValue_(max(0.35, self.key_label.alphaValue() - 0.05))

    @objc.python_method
    def handleEvent(self, event):
        event_type = event.get("type")
        if event_type == "viewer-status":
            self.online_count = int(event.get("onlineCount") or 0)
            self.viewers = event.get("viewers") or []
            self.updateViewerLabel()
        elif event_type == "key":
            text = event.get("text") or "-"
            viewer = event.get("viewerId")
            prefix = f"{viewer[:6]} " if viewer else ""
            self.key_label.setStringValue_(f"键盘：{prefix}{text}")
            self.key_label.setAlphaValue_(1.0)
            self.last_key_time = time.time()

    @objc.python_method
    def updateViewerLabel(self):
        if self.online_count <= 0:
            self.viewer_label.setStringValue_("无在线访问者")
            return

        short_viewers = []
        for viewer in self.viewers[:3]:
            viewer_id = (viewer.get("id") or "unknown")[:6]
            ip = viewer.get("ip") or "unknown"
            short_viewers.append(f"{viewer_id}@{ip}")
        extra = "" if self.online_count <= 3 else f" +{self.online_count - 3}"
        self.viewer_label.setStringValue_(f"在线 {self.online_count} 人：{', '.join(short_viewers)}{extra}")


def stdin_reader():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            COMMAND_QUEUE.put(json.loads(line))
        except Exception:
            continue


if __name__ == "__main__":
    threading.Thread(target=stdin_reader, daemon=True).start()
    app = NSApplication.sharedApplication()
    delegate = OverlayController.alloc().init()
    app.setDelegate_(delegate)
    NSApp.run()
