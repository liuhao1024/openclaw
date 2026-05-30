export type WhatsAppGroupMentionFacts = {
  effectiveWasMentioned: boolean;
  shouldBypassMention: boolean;
  needsMentionText?: boolean;
};

export type WhatsAppGroupActivationAbsenceReason = "not_reached" | "broadcast_target";

export type WhatsAppGroupActivationFacts =
  | {
      kind: "known";
      active: boolean;
      defaultRequiresMention: boolean;
    }
  | {
      kind: "absent";
      reason: WhatsAppGroupActivationAbsenceReason;
    };

export type WhatsAppGroupProcessingFacts = {
  mention: WhatsAppGroupMentionFacts;
  activation: WhatsAppGroupActivationFacts;
};

export type WhatsAppGroupGatingResult = WhatsAppGroupProcessingFacts & {
  shouldProcess: boolean;
};
