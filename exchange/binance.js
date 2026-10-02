// Read-only integration placeholder.
// Never enable withdrawal permissions for the audit service.

export function normalizeAccountRecord(record) {
  return {
    asset: record?.asset ?? null,
    free: record?.free ?? "0",
    locked: record?.locked ?? "0"
  };
}
