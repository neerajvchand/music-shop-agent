import { z } from "zod";

export const TimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):([0-5]\d)$/, "Must be HH:MM");

export const DayHoursSchema = z
  .object({
    open: TimeSchema,
    close: TimeSchema,
  })
  .nullable();

export const BusinessHoursSchema = z.record(
  z.enum([
    "monday",
    "tuesday",
    "wednesday",
    "thursday",
    "friday",
    "saturday",
    "sunday",
  ]),
  DayHoursSchema
);

export const ServiceModeSchema = z.enum(["in_person", "remote", "both"]);

export const ServiceSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(100),
  duration_minutes: z.number().int().min(5).max(480),
  price: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
  instructor: z.string().max(100).nullable().optional(),
  mode: ServiceModeSchema.default("both"),
  is_lesson: z.boolean().default(true),
});

export const LanguageMirrorSchema = z.object({
  trigger: z.string().min(1).max(50),
  response: z.string().min(1).max(50),
});

export const LanguagesSchema = z.object({
  mirrors: z.array(LanguageMirrorSchema).max(10).default([]),
});

export const RentalsSchema = z.object({
  short_term: z.object({
    enabled: z.boolean().default(false),
    day_rate: z.number().int().min(0).default(0),
    deposit: z.number().int().min(0).default(0),
  }),
  monthly_student: z.object({
    enabled: z.boolean().default(false),
    rate: z.number().int().min(0).default(0),
  }),
});

export const CancellationPolicySchema = z.object({
  enabled: z.boolean().default(false),
  hours_before: z.number().int().min(0).max(168).default(48),
  percent_charge: z.number().int().min(0).max(100).default(50),
  mention_when: z.enum(["asked_only", "proactive", "never"]).default("asked_only"),
});

export const PaymentPortalSchema = z.object({
  url: z.string().url().nullable().optional(),
  mention_autopay: z.boolean().default(false),
});

export const EscalationSchema = z.object({
  live_person_callback: z.boolean().default(false),
  callback_sla_text: z.string().max(60).default("shortly"),
});

export const TalentOnTourEntrySchema = z.object({
  instructor_name: z.string().min(1).max(100),
  status: z.enum(["available", "visiting", "away"]).default("visiting"),
  description: z.string().max(300).default(""),
  route_to: z
    .enum(["start_with_other_instructor", "callback_only", "remote_only"])
    .default("callback_only"),
});

export const TalentOnTourSchema = z.object({
  instructors: z.array(TalentOnTourEntrySchema).max(10).default([]),
});

export const AgePolicySchema = z.object({
  minimum_age: z.number().int().min(0).max(99).default(0),
  mode: z.enum(["hard", "soft"]).default("soft"),
});

export const ShopSettingsSchema = z.object({
  greeting: z.string().max(200),
  voice_id: z.string().min(1),
  business_hours: BusinessHoursSchema,
  services: z.array(ServiceSchema).max(20),
  booking_buffer_minutes: z.number().int().min(0).max(120).default(15),
  off_hours_behavior: z
    .enum(["voicemail", "take_message", "offer_callback"])
    .default("offer_callback"),

  public_phone: z.string().max(40).nullable().optional(),
  address: z.string().max(200).nullable().optional(),
  languages: LanguagesSchema.default({ mirrors: [] }),
  rentals: RentalsSchema.default({
    short_term: { enabled: false, day_rate: 0, deposit: 0 },
    monthly_student: { enabled: false, rate: 0 },
  }),
  cancellation_policy: CancellationPolicySchema.default({
    enabled: false,
    hours_before: 48,
    percent_charge: 50,
    mention_when: "asked_only",
  }),
  payment_portal: PaymentPortalSchema.default({ url: null, mention_autopay: false }),
  escalation: EscalationSchema.default({
    live_person_callback: false,
    callback_sla_text: "shortly",
  }),
  talent_on_tour: TalentOnTourSchema.default({ instructors: [] }),
  age_policy: AgePolicySchema.default({ minimum_age: 0, mode: "soft" }),
});

export type ShopSettings = z.infer<typeof ShopSettingsSchema>;
export type ServiceSettings = z.infer<typeof ServiceSchema>;
export type TalentOnTourEntry = z.infer<typeof TalentOnTourEntrySchema>;
export type LanguageMirror = z.infer<typeof LanguageMirrorSchema>;
