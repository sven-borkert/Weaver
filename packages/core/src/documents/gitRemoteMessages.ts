/** Project-member copy for a stored push error code; the operator-only cause lives in the diagnostics log. */
export const GIT_PUSH_ERROR_MESSAGES: Record<string, string> = {
  INVALID_REMOTE_URL: "Check the SSH remote URL.",
  INVALID_BRANCH: "Check the destination branch name.",
  INVALID_PRIVATE_KEY: "Replace the SSH key with a valid private key.",
  ENCRYPTED_PRIVATE_KEY:
    "Passphrase-protected keys are unsupported. Upload an unencrypted private key.",
  REPOSITORY_NOT_FOUND:
    "The repository could not be found. Check its URL and the key's access.",
  HOST_KEY_CHANGED:
    "The SSH host key has changed. Pushes are blocked; verify the server identity before reconnecting.",
  AUTHENTICATION_FAILED:
    "The SSH key was rejected. Check that it has write access to the repository.",
  REMOTE_REJECTED:
    "The remote rejected this push. Check branch protection and conflicting remote history.",
  NETWORK_ERROR:
    "The remote could not be reached or did not accept the SSH key. Weaver will retry. If this persists, an administrator can find the cause in the diagnostics log.",
  TIMEOUT: "The push timed out. Weaver will retry.",
  CANCELLED: "The push was interrupted. Weaver will retry if enabled.",
  PUSH_FAILED: "The push failed. Check the remote and key, then try again.",
  KEY_UNAVAILABLE:
    "The stored SSH key is unavailable. Replace it to resume pushes.",
  QUEUE_UNAVAILABLE:
    "The push queue is unavailable. Weaver will retry when it recovers.",
  WORKER_LOST: "The worker was interrupted. Weaver will retry.",
  REMOTE_BRANCH_MISSING:
    "The remote branch does not exist yet. Push first or check the branch name.",
  MERGE_FAILED:
    "Merging the remote branch failed. Resolve the conflict manually, then try again.",
  UNSUPPORTED_REMOTE_CONTENT:
    "The remote branch contains symbolic links or submodules. Remove them from the branch, then pull again.",
};
// A pull is always Owner-initiated, so its copy never promises a retry the
// pull scheduler would not perform.
export const GIT_PULL_ERROR_MESSAGES: Record<string, string> = {
  ...GIT_PUSH_ERROR_MESSAGES,
  REPOSITORY_NOT_FOUND:
    "The repository could not be found. Check its URL and the key's access.",
  HOST_KEY_CHANGED:
    "The SSH host key has changed. Pulls are blocked; verify the server identity before reconnecting.",
  AUTHENTICATION_FAILED:
    "The SSH key was rejected. Check that it has access to the repository.",
  NETWORK_ERROR:
    "The remote could not be reached or did not accept the SSH key. Try again; an administrator can find the cause in the diagnostics log.",
  TIMEOUT: "The pull timed out. Try again.",
  CANCELLED: "The pull was interrupted. Try again.",
  PUSH_FAILED: "The pull failed. Check the diagnostics log and try again.",
  KEY_UNAVAILABLE:
    "The stored SSH key is unavailable. Replace it before pulling.",
  QUEUE_UNAVAILABLE:
    "The job queue is unavailable. Try again once it recovers.",
  WORKER_LOST: "The worker was interrupted. Try again.",
};
export const GIT_PUSH_ERROR_FALLBACK =
  "The push failed. Check the remote and key, then try again.";
export const GIT_PULL_ERROR_FALLBACK =
  "The pull failed. Check the remote and key, then try again.";
