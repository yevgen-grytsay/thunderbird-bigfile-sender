"use strict";

const PAGE = messenger.runtime.getURL("ui/tab.html");

messenger.action.onClicked.addListener(async () => {
  const tabs = await messenger.tabs.query({});
  const existing = tabs.find((t) => t.url === PAGE);
  if (existing) {
    await messenger.tabs.update(existing.id, { active: true });
    await messenger.windows.update(existing.windowId, { focused: true });
  } else {
    await messenger.tabs.create({ url: PAGE });
  }
});
