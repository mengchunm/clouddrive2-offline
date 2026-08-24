import type { FileOperationResult } from "../proto/clouddrive_pb";

/**
 * CloudDrive2 may return a successful RPC transport response while reporting
 * an operation-level failure in the protobuf payload. Keep that contract in
 * one place so callers never mistake a rejected file operation for success.
 */
export function assertFileOperationSuccess(result: FileOperationResult, fallbackMessage: string): FileOperationResult {
  if (!result.success) {
    throw new Error(result.errorMessage?.trim() || fallbackMessage);
  }
  return result;
}
