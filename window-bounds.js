function fitBoundsToWorkArea(bounds, workArea) {
  return {
    ...bounds,
    x: Math.max(workArea.x, Math.min(bounds.x, workArea.x + workArea.width - bounds.width)),
    y: Math.max(workArea.y, Math.min(bounds.y, workArea.y + workArea.height - bounds.height)),
  };
}

module.exports = { fitBoundsToWorkArea };
