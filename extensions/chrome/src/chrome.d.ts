// The part of the Chrome extension API this extension uses.
declare namespace chrome.runtime {
  function sendMessage(message: unknown): Promise<unknown>;

  const onMessage: {
    addListener(listener: (message: unknown, sender: unknown, sendResponse: (response: unknown) => void) => boolean): void;
  };
}
