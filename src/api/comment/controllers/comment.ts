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
  async byGame(ctx) {
    const slug = ctx.params?.slug;
    if (!slug || typeof slug !== "string") {
      return ctx.badRequest("Missing slug");
    }

    const viewerId =
      typeof (ctx.state as any)?.user?.id === "number"
        ? (ctx.state as any).user.id
        : null;

    const game = await strapi.db.query("api::game.game").findOne({
      where: {
        slug,
      },
      select: ["id"],
    });
    const gameId = (game as any)?.id;
    if (typeof gameId !== "number") {
      ctx.body = { data: [] };
      return;
    }

    const comments = await strapi.db.query("api::comment.comment").findMany({
      where: {
        game: gameId,
        isApproved: true,
        isRejected: false,
      },
      orderBy: {
        createdAt: "desc",
      },
      populate: {
        author: true,
        likedBy: true,
        dislikedBy: true,
      },
    });

    ctx.body = {
      data: Array.isArray(comments)
        ? comments.map((c: any) => {
            const likedByIds = Array.isArray(c?.likedBy)
              ? (c.likedBy as unknown[])
                  .map((u) => (u && typeof u === "object" ? (u as any).id : null))
                  .filter((id): id is number => typeof id === "number")
              : [];
            const dislikedByIds = Array.isArray(c?.dislikedBy)
              ? (c.dislikedBy as unknown[])
                  .map((u) => (u && typeof u === "object" ? (u as any).id : null))
                  .filter((id): id is number => typeof id === "number")
              : [];

            const viewerReaction =
              typeof viewerId === "number"
                ? likedByIds.includes(viewerId)
                  ? "like"
                  : dislikedByIds.includes(viewerId)
                    ? "dislike"
                    : null
                : null;

            return {
              id: typeof c?.id === "number" ? c.id : null,
              content: typeof c?.content === "string" ? c.content : "",
              createdAt: typeof c?.createdAt === "string" ? c.createdAt : null,
              likesCount: likedByIds.length,
              dislikesCount: dislikedByIds.length,
              viewerReaction,
              author:
                c?.author && typeof c.author === "object"
                  ? {
                      id: typeof c.author.id === "number" ? c.author.id : null,
                      username:
                        typeof c.author.username === "string"
                          ? c.author.username
                          : null,
                    }
                  : null,
            };
          })
        : [],
    };
  },

  async react(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const commentIdRaw = body["commentId"];
    const reactionRaw = body["reaction"];

    const commentId =
      typeof commentIdRaw === "number"
        ? commentIdRaw
        : typeof commentIdRaw === "string"
          ? Number(commentIdRaw)
          : NaN;

    const reaction =
      reactionRaw === "like" || reactionRaw === "dislike" || reactionRaw === "none"
        ? reactionRaw
        : null;

    if (!Number.isFinite(commentId) || commentId <= 0) {
      return ctx.badRequest("Invalid commentId");
    }
    if (!reaction) return ctx.badRequest("Invalid reaction");

    const commentQuery = strapi.db.query("api::comment.comment");
    const existing = await commentQuery.findOne({
      where: { id: commentId },
      populate: {
        likedBy: true,
        dislikedBy: true,
      },
    });
    if (!existing) return ctx.notFound("Unknown comment");

    const likedByIds = Array.isArray((existing as any)?.likedBy)
      ? ((existing as any).likedBy as unknown[])
          .map((u) => (u && typeof u === "object" ? (u as any).id : null))
          .filter((id): id is number => typeof id === "number")
      : [];
    const dislikedByIds = Array.isArray((existing as any)?.dislikedBy)
      ? ((existing as any).dislikedBy as unknown[])
          .map((u) => (u && typeof u === "object" ? (u as any).id : null))
          .filter((id): id is number => typeof id === "number")
      : [];

    const likedSet = new Set<number>(likedByIds);
    const dislikedSet = new Set<number>(dislikedByIds);

    if (reaction === "like") {
      likedSet.add(user.id);
      dislikedSet.delete(user.id);
    } else if (reaction === "dislike") {
      dislikedSet.add(user.id);
      likedSet.delete(user.id);
    } else {
      likedSet.delete(user.id);
      dislikedSet.delete(user.id);
    }

    await commentQuery.update({
      where: { id: commentId },
      data: {
        likedBy: { set: Array.from(likedSet) },
        dislikedBy: { set: Array.from(dislikedSet) },
      },
    });

    const viewerReaction = likedSet.has(user.id)
      ? "like"
      : dislikedSet.has(user.id)
        ? "dislike"
        : null;

    ctx.body = {
      data: {
        id: commentId,
        likesCount: likedSet.size,
        dislikesCount: dislikedSet.size,
        viewerReaction,
      },
    };
  },

  async me(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const comments = await strapi.db.query("api::comment.comment").findMany({
      where: {
        author: user.id,
      },
      orderBy: {
        createdAt: "desc",
      },
      populate: {
        game: true,
      },
      limit: 50,
    });

    ctx.body = {
      data: Array.isArray(comments)
        ? comments.map((c: any) => ({
            id: typeof c?.id === "number" ? c.id : null,
            content: typeof c?.content === "string" ? c.content : "",
            isApproved: Boolean(c?.isApproved),
            isRejected: Boolean(c?.isRejected),
            createdAt: typeof c?.createdAt === "string" ? c.createdAt : null,
            game:
              c?.game && typeof c.game === "object"
                ? {
                    id: typeof c.game.id === "number" ? c.game.id : null,
                    title:
                      typeof c.game.title === "string" ? c.game.title : null,
                    slug: typeof c.game.slug === "string" ? c.game.slug : null,
                  }
                : null,
          }))
        : [],
    };
  },

  async submit(ctx) {
    const user = ctx.state.user;
    if (!user) return ctx.unauthorized();

    const body = (ctx.request.body ?? {}) as Record<string, unknown>;
    const content =
      typeof body["content"] === "string" ? body["content"].trim() : "";
    const gameSlug =
      typeof body["gameSlug"] === "string" ? body["gameSlug"] : "";

    if (!content || !gameSlug) return ctx.badRequest("Missing fields");

    const game = await strapi.db.query("api::game.game").findOne({
      where: {
        slug: gameSlug,
      },
      select: ["id", "slug", "title"],
    });
    const gameId = (game as any)?.id;
    if (typeof gameId !== "number") return ctx.notFound("Unknown game");

    const created = await strapi.db.query("api::comment.comment").create({
      data: {
        content,
        game: gameId,
        author: user.id,
        isApproved: false,
        isRejected: false,
      },
    });

    ctx.body = {
      data: created
        ? {
            id:
              typeof (created as any)?.id === "number"
                ? (created as any).id
                : null,
            content,
            isApproved: false,
            isRejected: false,
            game: {
              id: typeof gameId === "number" ? gameId : null,
              slug:
                typeof (game as any)?.slug === "string"
                  ? (game as any).slug
                  : null,
              title:
                typeof (game as any)?.title === "string"
                  ? (game as any).title
                  : null,
            },
          }
        : null,
    };
  },

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
        isRejected: false,
      },
    };

    return await super.create(ctx);
  },
}));
