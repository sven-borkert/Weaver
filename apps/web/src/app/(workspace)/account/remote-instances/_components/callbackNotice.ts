const ERRORS: Record<string, string> = {
  denied: "You declined the connection on the other instance.",
  state:
    "The connection attempt expired or was started by another account. Connect again.",
  token:
    "The other instance refused the connection. Ask its administrator whether this instance is registered there.",
  unknown: "The connection could not be completed. Try again.",
};

export function callbackNotice(params: {
  connected?: string;
  error?: string;
}): { kind: "success" | "error"; message: string } | null {
  if (params.connected)
    return {
      kind: "success",
      message:
        "Connected. You can now send documents and tables to this instance.",
    };
  if (params.error)
    return { kind: "error", message: ERRORS[params.error] ?? ERRORS.unknown! };
  return null;
}
