import { AppError, SYSTEM_ADMIN, uuidv7 } from "@tvn/core";
import type { FastifyInstance } from "fastify";
import type { ZodTypeProvider } from "fastify-type-provider-zod";
import { z } from "zod";
import type { TrackContext } from "../context.js";
import type { TrackDb } from "../db/schema.js";
import {
  FIELD_TYPES,
  fieldKey,
  normalizeCustomValues,
  type Field,
} from "../fields.js";

const OPTION_TYPES = new Set(["select", "multiselect", "cascade"]);
const OPERATIONS = ["create", "edit", "view", "transition", "portal"] as const;

const configSchema = z
  .object({
    /** Value new tickets get when the field is not filled in. */
    default: z.unknown(),
    /** Limits of a number field. */
    min: z.number(),
    max: z.number(),
  })
  .partial();

const optionSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  value: z.string(),
  position: z.number(),
  disabled: z.boolean(),
});
const fieldSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
  type: z.string(),
  system: z.boolean(),
  config: configSchema,
  options: z.array(optionSchema),
});

const idParam = z.object({ id: z.string() });
const notFound = () => new AppError(404, "not_found", "Not found");

/** Admin API for custom fields, their options and field layouts. */
export async function fieldRoutes(
  scope: FastifyInstance,
  ctx: TrackContext,
): Promise<void> {
  const { db } = ctx;
  const r = scope.withTypeProvider<ZodTypeProvider>();
  const admin = { permission: SYSTEM_ADMIN };
  // Field definitions are not secret: forms need them. Values are protected per ticket.
  const staff = { permission: "authenticated" as const };

  const toField = (
    f: Field,
    options: TrackDb["track_field_option"][],
  ): z.infer<typeof fieldSchema> => ({
    id: f.id,
    key: f.key,
    name: f.name,
    type: f.type,
    system: f.is_system,
    config: JSON.parse(f.config_json),
    options: options
      .filter((o) => o.field_id === f.id)
      .map((o) => ({
        id: o.id,
        parentId: o.parent_id,
        value: o.value,
        position: o.position,
        disabled: o.disabled,
      })),
  });
  const loadField = async (id: string) =>
    (await db
      .selectFrom("track_field")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst()) ?? Promise.reject(notFound());
  const customField = async (id: string) => {
    const field = await loadField(id);
    if (field.is_system)
      throw new AppError(409, "conflict", "System fields cannot be changed");
    return field;
  };
  const oneField = async (id: string) => {
    const field = await loadField(id);
    const options = await db
      .selectFrom("track_field_option")
      .selectAll()
      .where("field_id", "=", id)
      .orderBy("position")
      .execute();
    return toField(field, options);
  };
  /** A default must be a value the field would accept. */
  const checkDefault = async (field: Field) => {
    const { default: value } = JSON.parse(field.config_json) as {
      default?: unknown;
    };
    if (value !== undefined)
      await normalizeCustomValues(db, [field], { [field.key]: value });
  };

  r.get(
    "/fields",
    { config: staff, schema: { response: { 200: z.array(fieldSchema) } } },
    async () => {
      const [fields, options] = await Promise.all([
        db
          .selectFrom("track_field")
          .selectAll()
          .orderBy("is_system", "desc")
          .orderBy("name")
          .execute(),
        db
          .selectFrom("track_field_option")
          .selectAll()
          .orderBy("position")
          .execute(),
      ]);
      return fields.map((f) => toField(f, options));
    },
  );

  r.post(
    "/fields",
    {
      config: admin,
      schema: {
        body: z.object({
          key: fieldKey,
          name: z.string().trim().min(1).max(200),
          type: z.string(),
          config: configSchema.default({}),
        }),
        response: { 201: fieldSchema },
      },
    },
    async (req, reply) => {
      if (!Object.hasOwn(FIELD_TYPES, req.body.type)) {
        throw new AppError(
          400,
          "validation",
          `Unknown field type "${req.body.type}". Known: ${Object.keys(FIELD_TYPES).join(", ")}`,
        );
      }
      const field: Field = {
        id: uuidv7(),
        key: req.body.key,
        name: req.body.name,
        type: req.body.type,
        is_system: false,
        config_json: JSON.stringify(req.body.config),
      };
      // Options do not exist yet, so a default that points at one cannot be checked here.
      if (!OPTION_TYPES.has(field.type)) await checkDefault(field);
      else if (req.body.config.default !== undefined)
        throw new AppError(
          400,
          "validation",
          "Add options first, then set the default",
        );

      await db.transaction().execute(async (trx) => {
        // Compared without case: the key becomes an SQL column name.
        const taken = (
          await trx.selectFrom("track_field").select("key").execute()
        ).some((f) => f.key.toLowerCase() === field.key);
        if (taken)
          throw new AppError(
            409,
            "conflict",
            `Field key "${field.key}" is already in use`,
          );
        await trx.insertInto("track_field").values(field).execute();
      });
      return reply.status(201).send(toField(field, []));
    },
  );

  r.patch(
    "/fields/:id",
    {
      config: admin,
      schema: {
        params: idParam,
        body: z
          .object({
            name: z.string().trim().min(1).max(200),
            config: configSchema,
          })
          .partial(),
        response: { 200: fieldSchema },
      },
    },
    async (req) => {
      const field = await customField(req.params.id);
      const next: Field = {
        ...field,
        name: req.body.name ?? field.name,
        config_json: req.body.config
          ? JSON.stringify(req.body.config)
          : field.config_json,
      };
      await checkDefault(next);
      await db
        .updateTable("track_field")
        .set({ name: next.name, config_json: next.config_json })
        .where("id", "=", field.id)
        .execute();
      return oneField(field.id);
    },
  );

  r.delete(
    "/fields/:id",
    { config: admin, schema: { params: idParam, response: { 204: z.null() } } },
    async (req, reply) => {
      const field = await customField(req.params.id);
      // Values, options and layout entries go with the field (cascade).
      await db.deleteFrom("track_field").where("id", "=", field.id).execute();
      return reply.status(204).send(null);
    },
  );

  // --- Options ----------------------------------------------------------------------

  r.post(
    "/fields/:id/options",
    {
      config: admin,
      schema: {
        params: idParam,
        body: z.object({
          value: z.string().trim().min(1).max(500),
          parentId: z.string().nullable().default(null),
        }),
        response: { 201: fieldSchema },
      },
    },
    async (req, reply) => {
      const field = await customField(req.params.id);
      if (!OPTION_TYPES.has(field.type))
        throw new AppError(
          409,
          "conflict",
          `Fields of type "${field.type}" have no options`,
        );
      const { value, parentId } = req.body;
      await db.transaction().execute(async (trx) => {
        const siblings = await trx
          .selectFrom("track_field_option")
          .selectAll()
          .where("field_id", "=", field.id)
          .execute();
        if (parentId !== null) {
          const parent = siblings.find((o) => o.id === parentId);
          if (
            field.type !== "cascade" ||
            !parent ||
            parent.parent_id !== null
          ) {
            throw new AppError(
              400,
              "validation",
              "Only cascading fields have child options, one level deep",
            );
          }
        }
        const level = siblings.filter((o) => o.parent_id === parentId);
        if (level.some((o) => o.value === value))
          throw new AppError(
            409,
            "conflict",
            `Option "${value}" already exists`,
          );
        await trx
          .insertInto("track_field_option")
          .values({
            id: uuidv7(),
            field_id: field.id,
            parent_id: parentId,
            value,
            position: Math.max(-1, ...level.map((o) => o.position)) + 1,
            disabled: false,
          })
          .execute();
      });
      return reply.status(201).send(await oneField(field.id));
    },
  );

  r.patch(
    "/fields/:id/options/:optionId",
    {
      config: admin,
      schema: {
        params: idParam.extend({ optionId: z.string() }),
        // Options are disabled, not deleted: tickets keep pointing at them.
        body: z
          .object({
            value: z.string().trim().min(1).max(500),
            disabled: z.boolean(),
            position: z.number().int().min(0),
          })
          .partial(),
        response: { 200: fieldSchema },
      },
    },
    async (req) => {
      const field = await customField(req.params.id);
      const { value, disabled, position } = req.body;
      const result = await db
        .updateTable("track_field_option")
        .set({
          ...(value !== undefined && { value }),
          ...(disabled !== undefined && { disabled }),
          ...(position !== undefined && { position }),
        })
        .where("id", "=", req.params.optionId)
        .where("field_id", "=", field.id)
        .executeTakeFirst();
      if (result.numUpdatedRows === 0n && Object.keys(req.body).length > 0) {
        const exists = await db
          .selectFrom("track_field_option")
          .select("id")
          .where("id", "=", req.params.optionId)
          .where("field_id", "=", field.id)
          .executeTakeFirst();
        if (!exists) throw notFound();
      }
      return oneField(field.id);
    },
  );

  // --- Layouts ----------------------------------------------------------------------

  const itemSchema = z.object({
    fieldId: z.string(),
    required: z.boolean().default(false),
    hidden: z.boolean().default(false),
    tab: z.string().max(100).default(""),
  });
  const layoutSchema = z.object({
    id: z.string(),
    name: z.string(),
    items: z.record(z.enum(OPERATIONS), z.array(itemSchema)),
  });

  const oneLayout = async (
    id: string,
  ): Promise<z.infer<typeof layoutSchema>> => {
    const layout = await db
      .selectFrom("track_field_layout")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (!layout) throw notFound();
    const rows = await db
      .selectFrom("track_field_layout_item")
      .selectAll()
      .where("layout_id", "=", id)
      .orderBy("position")
      .execute();
    const items = Object.fromEntries(
      OPERATIONS.map((op) => [
        op,
        rows
          .filter((i) => i.operation === op)
          .map((i) => ({
            fieldId: i.field_id,
            required: i.required,
            hidden: i.hidden,
            tab: i.tab,
          })),
      ]),
    ) as z.infer<typeof layoutSchema>["items"];
    return { id: layout.id, name: layout.name, items };
  };

  r.get(
    "/field-layouts",
    {
      config: staff,
      schema: {
        response: {
          200: z.array(z.object({ id: z.string(), name: z.string() })),
        },
      },
    },
    () =>
      db
        .selectFrom("track_field_layout")
        .select(["id", "name"])
        .orderBy("name")
        .execute(),
  );

  r.get(
    "/field-layouts/:id",
    {
      config: staff,
      schema: { params: idParam, response: { 200: layoutSchema } },
    },
    (req) => oneLayout(req.params.id),
  );

  r.post(
    "/field-layouts",
    {
      config: admin,
      schema: {
        body: z.object({
          name: z.string().trim().min(1).max(200),
          copyFrom: z.string().optional(),
        }),
        response: { 201: layoutSchema },
      },
    },
    async (req, reply) => {
      const id = uuidv7();
      const copyFrom =
        req.body.copyFrom ?? (await ctx.defaults()).fieldLayoutId;
      await db.transaction().execute(async (trx) => {
        const source = await trx
          .selectFrom("track_field_layout_item")
          .selectAll()
          .where("layout_id", "=", copyFrom)
          .execute();
        if (source.length === 0)
          throw new AppError(400, "validation", "Unknown layout to copy from");
        await trx
          .insertInto("track_field_layout")
          .values({ id, name: req.body.name })
          .execute();
        await trx
          .insertInto("track_field_layout_item")
          .values(source.map((i) => ({ ...i, layout_id: id })))
          .execute();
      });
      return reply.status(201).send(await oneLayout(id));
    },
  );

  r.put(
    "/field-layouts/:id/:operation",
    {
      config: admin,
      schema: {
        params: idParam.extend({ operation: z.enum(OPERATIONS) }),
        body: z.array(itemSchema).max(500),
        response: { 200: layoutSchema },
      },
    },
    async (req) => {
      const { id, operation } = req.params;
      const items = req.body;
      await oneLayout(id);
      const fields = await db
        .selectFrom("track_field")
        .select(["id", "key"])
        .execute();
      const keys = new Map(fields.map((f) => [f.id, f.key]));
      if (
        new Set(items.map((i) => i.fieldId)).size !== items.length ||
        items.some((i) => !keys.has(i.fieldId))
      ) {
        throw new AppError(
          400,
          "validation",
          "Every entry must name a different, existing field",
        );
      }
      // A ticket without a summary cannot exist, whatever a layout says.
      const summary = items.find((i) => keys.get(i.fieldId) === "summary");
      if (
        (operation === "create" || operation === "edit") &&
        (!summary || !summary.required || summary.hidden)
      ) {
        throw new AppError(
          400,
          "validation",
          "Summary must stay on create and edit forms, required and visible",
        );
      }
      if (items.some((i) => i.required && i.hidden))
        throw new AppError(
          400,
          "validation",
          "A hidden field cannot be required",
        );

      await db.transaction().execute(async (trx) => {
        await trx
          .deleteFrom("track_field_layout_item")
          .where("layout_id", "=", id)
          .where("operation", "=", operation)
          .execute();
        if (items.length) {
          await trx
            .insertInto("track_field_layout_item")
            .values(
              items.map((i, position) => ({
                layout_id: id,
                operation,
                field_id: i.fieldId,
                position,
                tab: i.tab,
                required: i.required,
                hidden: i.hidden,
              })),
            )
            .execute();
        }
      });
      return oneLayout(id);
    },
  );
}
