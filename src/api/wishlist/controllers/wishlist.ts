import { factories } from "@strapi/strapi";

export default factories.createCoreController("api::wishlist.wishlist", () => ({
  async me(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const wishlist = await strapi.db.query("api::wishlist.wishlist").findOne({
      where: {
        user: user.id,
      },
      populate: {
        games: {
          populate: {
            images: true,
            categories: true,
            mechanics: true,
            publisher: true,
          },
        },
      },
    });

    ctx.body = {
      documentId:
        typeof (wishlist as any)?.documentId === "string"
          ? (wishlist as any).documentId
          : null,
      games: Array.isArray((wishlist as any)?.games)
        ? (wishlist as any).games
        : [],
    };
  },

  async toggle(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const gameSlug =
      typeof body["gameSlug"] === "string" ? body["gameSlug"] : "";
    if (!gameSlug) return ctx.badRequest("Missing gameSlug");

    const game = await strapi.db.query("api::game.game").findOne({
      where: {
        slug: gameSlug,
      },
      select: ["id", "documentId", "slug"],
    });
    if (!game) return ctx.notFound("Unknown game");

    const wishlistQuery = strapi.db.query("api::wishlist.wishlist");
    const wishlist = await wishlistQuery.findOne({
      where: {
        user: user.id,
      },
      populate: {
        games: true,
      },
    });

    const gameId = (game as any).id;
    if (typeof gameId !== "number") {
      return ctx.badRequest("Invalid game");
    }

    const currentGameIds = Array.isArray((wishlist as any)?.games)
      ? ((wishlist as any).games as unknown[])
          .map((g) => (g && typeof g === "object" ? (g as any).id : null))
          .filter((id): id is number => typeof id === "number")
      : [];

    const nextGameIds = currentGameIds.includes(gameId)
      ? currentGameIds.filter((id) => id !== gameId)
      : [...currentGameIds, gameId];

    if (!wishlist) {
      await wishlistQuery.create({
        data: {
          user: user.id,
          games: { set: nextGameIds },
        },
      });
    } else {
      await wishlistQuery.update({
        where: {
          id: (wishlist as any).id,
        },
        data: {
          games: { set: nextGameIds },
        },
      });
    }

    ctx.body = { active: nextGameIds.includes(gameId) };
  },

  async find(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    ctx.query = {
      ...ctx.query,
      filters: {
        user: { id: { $eq: user.id } },
      },
    };

    return await super.find(ctx);
  },

  async findOne(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const id = ctx.params?.id;
    if (!id) return ctx.notFound();

    const entity = await strapi.entityService.findOne(
      "api::wishlist.wishlist",
      id,
      {
        populate: ["user"],
      },
    );
    const ownerId =
      (entity as { user?: { id?: number } } | null)?.user?.id ?? null;
    if (ownerId !== user.id) return ctx.forbidden();

    return await super.findOne(ctx);
  },

  async create(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const data =
      (body["data"] && typeof body["data"] === "object"
        ? (body["data"] as Record<string, unknown>)
        : {}) ?? {};

    ctx.request.body = {
      ...body,
      data: {
        ...data,
        user: user.id,
      },
    };

    return await super.create(ctx);
  },

  async update(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const id = ctx.params?.id;
    if (!id) return ctx.notFound();

    const entity = await strapi.entityService.findOne(
      "api::wishlist.wishlist",
      id,
      {
        populate: ["user"],
      },
    );
    const ownerId =
      (entity as { user?: { id?: number } } | null)?.user?.id ?? null;
    if (ownerId !== user.id) return ctx.forbidden();

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const data =
      (body["data"] && typeof body["data"] === "object"
        ? (body["data"] as Record<string, unknown>)
        : {}) ?? {};

    ctx.request.body = {
      ...body,
      data: {
        ...data,
        user: user.id,
      },
    };

    return await super.update(ctx);
  },
}));
