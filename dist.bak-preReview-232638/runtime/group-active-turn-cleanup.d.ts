type ActiveTurnUiCleanup = {
    token: symbol;
    cancel: () => void | Promise<void>;
};
export declare const activeTurnUiCleanupByQueue: Map<string, ActiveTurnUiCleanup>;
export {};
