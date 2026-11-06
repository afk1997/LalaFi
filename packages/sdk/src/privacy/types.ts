export type PrivacyRule = 'W1' | 'W2' | 'W3' | 'W4' | 'W5' | 'W6' | 'W8';
export type FindingLevel = 'info' | 'warn' | 'block';

export interface Finding {
  rule: PrivacyRule;
  level: FindingLevel;
  message: string;
  /** CLI flag that overrides a block, if any. */
  overrideFlag?: string;
}

/** CLI override flags for the blocking rules (PRD 12.3 "flag" / "explicit flag"). */
export const OVERRIDE_FLAGS = {
  W1: '--self-relay --i-understand-linkability',
  W2: '--allow-linked-recipient',
  W3: '--ignore-delay',
  W4: '--ignore-anonymity',
  W8: '--no-tor',
} as const;

export interface Overrides {
  /** W2 */
  allowLinkedRecipient?: boolean;
  /** W3 */
  ignoreDelay?: boolean;
  /** W4 */
  ignoreAnonymity?: boolean;
}
