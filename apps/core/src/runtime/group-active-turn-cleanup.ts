type ActiveTurnUiCleanup = {
  token: symbol;
  cancel: () => void | Promise<void>;
};

export const activeTurnUiCleanupByQueue = new Map<
  string,
  ActiveTurnUiCleanup
>();
