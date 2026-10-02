// SPDX-License-Identifier: Apache-2.0
/**
 * The risk gate: which work is high-risk, for oversight ("verify these changes yourself") and for
 * expertise leases (check the official docs first).
 *
 * Mistakes in authentication, payments, data migrations or cryptography are SILENT (nothing fails loudly,
 * the hole just sits there) and expensive, so this layer asks for more verification there. It only ever
 * ADDS verification; it never removes a requirement.
 *
 * LANGUAGE-NEUTRAL by construction: it never reads the person's language. Two vocabularies, neither of
 * them a human language:
 *  - IDENTIFIERS (`RISK_TERMS_BY_DOMAIN`): protocols, standards, acronyms and product names (oauth, jwt,
 *    stripe, sql, xss, gdpr) that a prompt carries the same way in every language. These are the only
 *    words read from a prompt.
 *  - CODE WORDS (`CODE_PATH_TERMS`): the names code gives its directories and files (auth/, payments/,
 *    migrations/). Read only from file PATHS, where they are identifiers rather than anyone's prose.
 * Before this, the prompt list mixed English and Turkish words ("password", "parola", "ödeme"), which held
 * people writing in those two languages to a different rule than everyone else. A learned habit that
 * would lower verification is no longer gated by this at all: it is never delivered (`user-delivery.ts`),
 * because "is this task risky?" decided from the person's words is exactly the judgement a word list can
 * only make in the languages it lists.
 *
 * Deterministic and deliberately coarse; it errs toward firing, because a false positive costs one extra
 * self-check. Words Pathrule itself uses daily in a non-security sense ("token" budgets, agent "sessions")
 * are left out. The terms are FOLDED (see `foldText`) and travel to `pathrule-hook.js` inside the hook
 * index, so the standalone hook and Studio apply one list and cannot drift apart.
 */
import { foldedWords } from "./text-fold.js";

export type RiskDomain = "auth" | "crypto" | "payments" | "data" | "security";

export const RISK_DOMAINS: readonly RiskDomain[] = ["auth", "crypto", "payments", "data", "security"];

/** Identifiers written the same way in any language. The only risk words read from a prompt. */
export const RISK_TERMS_BY_DOMAIN: Readonly<Record<RiskDomain, readonly string[]>> = {
  auth: ["oauth", "oidc", "saml", "jwt", "mfa", "2fa", "otp", "totp", "sso", "rbac", "abac", "ldap", "kerberos", "webauthn", "passkey"],
  crypto: ["hmac", "aes", "rsa", "ecdsa", "ed25519", "sha256", "bcrypt", "argon2", "pbkdf2", "tls", "ssl", "x509", "keychain", "crypto"],
  payments: ["stripe", "paypal", "adyen", "braintree", "paddle", "klarna", "mollie", "razorpay", "iyzico", "mercadopago", "pci"],
  data: ["sql", "rls", "postgres", "postgresql", "mysql", "sqlite", "mongodb", "supabase", "prisma", "drizzle"],
  security: ["xss", "csrf", "sqli", "ssrf", "cors", "csp", "owasp", "cve", "e2e", "pii", "gdpr", "kvkk", "ccpa", "lgpd", "hipaa"],
};

/**
 * The words code names its directories and files with. PATHS ONLY: in a path they are identifiers, in a
 * prompt they would be one language's prose. "auth" is paths-only too: in a prompt it is as often
 * Pathrule's own sign-in plumbing.
 */
export const CODE_PATH_TERMS: Readonly<Record<RiskDomain, readonly string[]>> = {
  auth: ["auth", "login", "logout", "signin", "signup", "password", "passwords", "passwd", "credential", "credentials", "authent", "authoriz", "permission"],
  crypto: ["encrypt", "decrypt", "cryptograph", "signature", "secret", "secrets"],
  payments: ["payment", "payments", "billing", "checkout", "invoice", "refund", "subscription"],
  data: ["migration", "migrations", "schema", "truncate", "backup", "restore", "database", "production"],
  security: ["security", "vulnerab", "injection", "sanitiz", "privacy"],
};

/** Every prompt-side risk identifier, flat. */
export const RISK_TERMS: readonly string[] = [...new Set(Object.values(RISK_TERMS_BY_DOMAIN).flat())];

/**
 * One risk term against one prompt word.
 *
 * Exact for anything shorter than five letters ("prod" must not meet "product", "drop" must not meet
 * "dropdown"), otherwise the word may extend the term ("authent" meets "authentication", "postgres"
 * meets "postgresql"). The hook applies the same rule.
 */
export function riskTermMatches(term: string, word: string): boolean {
  if (word === term) return true;
  return term.length >= 5 && word.startsWith(term);
}

export interface TaskRisk {
  high: boolean;
  domains: RiskDomain[];
}

/** Classify a task by the identifiers it names, in any language. Empty or unreadable text is not high-risk. */
export function classifyTaskRisk(text: string): TaskRisk {
  const words = new Set(foldedWords(text ?? ""));
  const domains: RiskDomain[] = [];
  for (const [domain, terms] of Object.entries(RISK_TERMS_BY_DOMAIN) as Array<[RiskDomain, readonly string[]]>) {
    if (terms.some((term) => [...words].some((word) => riskTermMatches(term, word)))) domains.push(domain);
  }
  return { high: domains.length > 0, domains };
}

/** The domains a workspace-relative path sits in, by its folded segments. */
export function classifyPathRisk(path: string): RiskDomain[] {
  const words = foldedWords(path ?? "");
  return RISK_DOMAINS.filter((domain) => {
    const terms = [...RISK_TERMS_BY_DOMAIN[domain], ...CODE_PATH_TERMS[domain]];
    return terms.some((term) => words.some((word) => riskTermMatches(term, word)));
  });
}
