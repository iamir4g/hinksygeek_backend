export default {
  routes: [
    {
      method: "GET",
      path: "/comments/by-game/:slug",
      handler: "comment.byGame",
      config: {
        auth: false,
      },
    },
    {
      method: "GET",
      path: "/comments/me",
      handler: "comment.me",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/comments/submit",
      handler: "comment.submit",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/comments/react",
      handler: "comment.react",
      config: {
        auth: {},
      },
    },
  ],
};
