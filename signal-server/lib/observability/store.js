function createRecentEventStore(options = {}) {
  const capacity = Math.max(1, Number(options.capacity) || 200);
  const items = [];

  function append(event) {
    const stored = {
      ...event,
      correlation: event?.correlation && typeof event.correlation === 'object'
        ? { ...event.correlation }
        : {},
      meta: event?.meta && typeof event.meta === 'object'
        ? { ...event.meta }
        : {},
    };
    items.push(stored);
    while (items.length > capacity) {
      items.shift();
    }
    return stored;
  }

  function recent(optionsLike = {}) {
    const limit = Math.max(1, Number(optionsLike.limit) || capacity);
    const domain = String(optionsLike.domain || '').trim();
    const filtered = domain
      ? items.filter((item) => item.domain === domain)
      : items.slice();
    return filtered.slice(-limit).map((item) => ({
      ...item,
      correlation: { ...(item.correlation || {}) },
      meta: { ...(item.meta || {}) },
    }));
  }

  function summary() {
    const counts = {
      total: items.length,
      byDomain: {},
      byEvent: {},
      byLevel: {},
    };

    items.forEach((item) => {
      const domain = String(item.domain || 'unknown');
      const event = String(item.event || 'unknown');
      const eventKey = `${domain}.${event}`;
      const level = String(item.level || 'info');

      counts.byDomain[domain] = (counts.byDomain[domain] || 0) + 1;
      counts.byEvent[eventKey] = (counts.byEvent[eventKey] || 0) + 1;
      counts.byLevel[level] = (counts.byLevel[level] || 0) + 1;
    });

    return counts;
  }

  return {
    append,
    recent,
    summary,
  };
}

module.exports = {
  createRecentEventStore,
};
