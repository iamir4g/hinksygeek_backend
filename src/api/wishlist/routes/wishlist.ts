export default {
  routes: [
    {
      method: "GET",
      path: "/wishlist/me",
      handler: "wishlist.me",
      config: {
        auth: {},
      },
    },
    {
      method: "POST",
      path: "/wishlist/toggle",
      handler: "wishlist.toggle",
      config: {
        auth: {},
      },
    },
  ],
};
