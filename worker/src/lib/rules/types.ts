export type RuleCondition =
  | {
      field: "from_address";
      operator: "equals" | "contains" | "ends_with";
      value: string;
    }
  | { field: "from_domain"; operator: "equals"; value: string }
  | {
      field: "subject";
      operator: "contains" | "equals" | "starts_with";
      value: string;
    }
  | { field: "body"; operator: "contains"; value: string }
  | { field: "has_attachments"; operator: "is"; value: boolean }
  | { field: "spam_score"; operator: "gte" | "lte"; value: number }
  | {
      field: "header";
      name: string;
      operator: "equals" | "contains";
      value: string;
    };

export type RuleAction =
  | { type: "archive" }
  | { type: "mark_spam" }
  | { type: "move_to_folder"; mailboxId: string }
  | { type: "snooze"; hours: number }
  | { type: "assign"; userId: string };
