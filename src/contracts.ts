import { z } from "zod";

const pageSize = z.number().int().min(1).max(500).default(100)
  .describe("Objects per page. The Atlas API caps page_size at 500.");
const page = z.number().int().min(1).optional();

const measurementType = z.enum(["ping", "traceroute", "dns", "http", "sslcert", "ntp"]);
const measurementId = z.number().int().positive();
const probeId = z.number().int().positive();

export const listProbesInput = z.strictObject({
  search: z.string().min(1).max(200).optional(),
  country: z.string().length(2).optional().describe("ISO country code, e.g. \"NL\"."),
  asn: z.number().int().positive().optional(),
  status: z.string().min(1).max(50).optional(),
  tags: z.string().min(1).max(200).optional(),
  page_size: pageSize,
  page,
});

export const getProbeInput = z.strictObject({ probe_id: probeId });

export const listMeasurementsInput = z.strictObject({
  status: z.string().min(1).max(50).optional().describe("e.g. \"ongoing\" or \"stopped\"."),
  type: measurementType.optional(),
  target: z.string().min(1).max(500).optional(),
  page_size: pageSize,
  page,
});

export const listMyMeasurementsInput = z.strictObject({
  page_size: pageSize,
  page,
});

export const getMeasurementInput = z.strictObject({ measurement_id: measurementId });

export const getMeasurementResultsInput = z.strictObject({
  measurement_id: measurementId,
  start: z.number().int().optional().describe("Unix timestamp; only results at or after this time."),
  stop: z.number().int().optional().describe("Unix timestamp; only results at or before this time."),
  page_size: z.number().int().min(1).max(500).default(500),
  max_pages: z.number().int().min(1).max(5).default(1)
    .describe("Pages to fetch by following the API's next link. Each page is one upstream request."),
  summarize: z.boolean().default(true)
    .describe("Include min/avg/max over the rtt and avg values found in the fetched rows."),
});

const definition = z.looseObject({
  type: measurementType,
  target: z.string().min(1).max(500),
  description: z.string().max(200).optional(),
  af: z.union([z.literal(4), z.literal(6)]).optional(),
  interval: z.number().int().positive().optional(),
  packets: z.number().int().min(1).max(16).optional(),
  timeout: z.number().int().positive().optional(),
}).describe(
  "One measurement definition. Type-specific fields (e.g. query_type for DNS, method for HTTP) pass through to the Atlas API.",
);

const probeSelection = z.strictObject({
  type: z.enum(["id", "area", "country", "asn", "prefix", "tags", "probes"]),
  value: z.string().min(1).max(500),
  requested: z.number().int().min(1).max(1000).optional(),
});

export const createMeasurementInput = z.strictObject({
  definitions: z.array(definition).min(1).max(10),
  probes: z.array(probeSelection).min(1).max(10),
  is_oneoff: z.boolean().default(false),
  bill_to: z.string().max(200).optional(),
});

export const stopMeasurementInput = z.strictObject({ measurement_id: measurementId });

export type Operation =
  | { readonly name: "list_probes"; readonly input: z.infer<typeof listProbesInput> }
  | { readonly name: "get_probe"; readonly input: z.infer<typeof getProbeInput> }
  | { readonly name: "list_measurements"; readonly input: z.infer<typeof listMeasurementsInput> }
  | { readonly name: "list_my_measurements"; readonly input: z.infer<typeof listMyMeasurementsInput> }
  | { readonly name: "get_measurement"; readonly input: z.infer<typeof getMeasurementInput> }
  | { readonly name: "get_measurement_results"; readonly input: z.infer<typeof getMeasurementResultsInput> }
  | { readonly name: "create_measurement"; readonly input: z.infer<typeof createMeasurementInput> }
  | { readonly name: "stop_measurement"; readonly input: z.infer<typeof stopMeasurementInput> };
