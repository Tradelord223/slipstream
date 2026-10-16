// Stand-in until web/src/lib/safetyFacts.ts is merged to main. When it is, import `safetyFacts` from there in
// PrivacySettings.tsx and delete this file. Same shape and export name as the real one.
export interface SafetyFact {
  title: string;
  body: string;
}
export const safetyFacts: SafetyFact[] = [];
