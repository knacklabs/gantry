export type ActiveTurnUiCleanup = {
  token: symbol;
  cancel: () => void | Promise<void>;
};
