import { factories } from "@strapi/strapi";

function getIsApprovedFromEntity(entity: unknown) {
  if (!entity || typeof entity !== "object") return null;
  const direct = (entity as Record<string, unknown>)["isApproved"];
  if (typeof direct === "boolean") return direct;
  const attributes = (entity as Record<string, unknown>)["attributes"];
  if (!attributes || typeof attributes !== "object") return null;
  const nested = (attributes as Record<string, unknown>)["isApproved"];
  return typeof nested === "boolean" ? nested : null;
}

export default factories.createCoreController("api::comment.comment", () => ({
  async find(ctx) {
    const isAuthenticated = Boolean(ctx.state.user);
    if (!isAuthenticated) {
      const filters =
        (ctx.query?.filters && typeof ctx.query.filters === "object"
          ? (ctx.query.filters as Record<string, unknown>)
          : {}) ?? {};
      ctx.query = {
        ...ctx.query,
        filters: {
          ...filters,
          isApproved: { $eq: true },
        },
      };
    }

    return await super.find(ctx);
  },

  async findOne(ctx) {
    const res = await super.findOne(ctx);
    const isAuthenticated = Boolean(ctx.state.user);
    const entity = (res as { data?: unknown } | null)?.data ?? null;
    const isApproved = getIsApprovedFromEntity(entity);
    if (!isAuthenticated && isApproved === false) {
      return ctx.notFound();
    }
    return res;
  },

  async create(ctx) {
    const user = ctx.state.user;
    if (!user) {
      return ctx.unauthorized();
    }

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const data =
      (body["data"] && typeof body["data"] === "object"
        ? (body["data"] as Record<string, unknown>)
        : {}) ?? {};

    ctx.request.body = {
      ...body,
      data: {
        ...data,
        author: user.id,
        isApproved: false,
      },
    };

    return await super.create(ctx);
  },
}));
