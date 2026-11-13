/** Accounts approved on first sign-in: each gets its own empty workspace and never sees anyone else's data. */
export const AUTO_APPROVED_EMAILS = ["lulox.eth@gmail.com", "kathonejo@gmail.com"];

export function isAutoApproved(email: string, adminEmail: string): boolean {
  const e = email.trim().toLowerCase();
  return e === adminEmail.trim().toLowerCase() || AUTO_APPROVED_EMAILS.includes(e);
}
