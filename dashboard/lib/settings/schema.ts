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

export const ServiceSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(100),
  duration_minutes: z.number().int().min(5).max(480),
  price: z.number().int().min(0).nullable().optional(),
  active: z.boolean().default(true),
});

export const ShopSettingsSchema = z.object({
  greeting: z.string().max(200),
  voice_id: z.string().min(1),
  business_hours: BusinessHoursSchema,
  services: z.array(ServiceSchema).max(20),
  booking_buffer_minutes: z
    .number()
    .int()
    .min(0)
    .max(120)
    .default(15),
  off_hours_behavior: z
    .enum(["voicemail", "take_message", "offer_callback"])
    .default("offer_callback"),
});

export type ShopSettings = z.infer<typeof ShopSettingsSchema>;
