export default {
  routes: [
    {
      method: 'GET',
      path: '/games/:slug/wishlist-count',
      handler: 'game.wishlistCount',
      config: {
        auth: false,
      },
    },
  ],
};

