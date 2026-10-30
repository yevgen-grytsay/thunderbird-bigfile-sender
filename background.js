"use strict";

// Кожен клік відкриває нову вкладку відправки.
// Кожна вкладка — окрема сторінка з власним станом у пам'яті, вони не залежать одна від одної.
const PAGE = messenger.runtime.getURL("ui/tab.html");

messenger.action.onClicked.addListener(async () => {
  await messenger.tabs.create({ url: PAGE });
});
