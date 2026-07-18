const InputGeometry = (() => {
  function clamp(value) {
    return Math.max(0, Math.min(1, value));
  }

  function outside() {
    return { relX: 0, relY: 0, inside: false };
  }

  function mapClientPoint({
    clientX,
    clientY,
    rect,
    sourceWidth,
    sourceHeight,
    objectFit = 'contain',
  } = {}) {
    const width = Number(rect?.width);
    const height = Number(rect?.height);
    const sourceW = Number(sourceWidth);
    const sourceH = Number(sourceHeight);
    if (![width, height, sourceW, sourceH].every((value) => Number.isFinite(value) && value > 0)) {
      return outside();
    }

    const localX = Number(clientX) - Number(rect.left || 0);
    const localY = Number(clientY) - Number(rect.top || 0);
    const fit = ['contain', 'cover', 'fill'].includes(objectFit) ? objectFit : 'contain';
    if (fit === 'fill') {
      const rawX = localX / width;
      const rawY = localY / height;
      return {
        relX: clamp(rawX),
        relY: clamp(rawY),
        inside: rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1,
      };
    }

    const scale = fit === 'cover'
      ? Math.max(width / sourceW, height / sourceH)
      : Math.min(width / sourceW, height / sourceH);
    const contentWidth = sourceW * scale;
    const contentHeight = sourceH * scale;
    const offsetX = (width - contentWidth) / 2;
    const offsetY = (height - contentHeight) / 2;
    const rawX = (localX - offsetX) / contentWidth;
    const rawY = (localY - offsetY) / contentHeight;
    const insideDisplay = localX >= 0 && localX <= width && localY >= 0 && localY <= height;
    const insideContent = rawX >= 0 && rawX <= 1 && rawY >= 0 && rawY <= 1;
    return {
      relX: clamp(rawX),
      relY: clamp(rawY),
      inside: insideDisplay && (fit === 'cover' || insideContent),
    };
  }

  return { mapClientPoint };
})();

if (typeof module !== 'undefined') {
  module.exports = { InputGeometry };
}
