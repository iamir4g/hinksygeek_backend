import type { StrapiApp } from "@strapi/strapi/admin";

import fa from "./extensions/translations/fa.json";

export default {
  config: {
    locales: ["fa"],
    languageNativeNames: {
      fa: "فارسی",
    },
    translations: {
      fa,
    },
  },
  bootstrap(_app: StrapiApp) {
    // Strapi defaults to English until the user picks a locale in Profile.
    if (typeof window !== "undefined") {
      const key = "strapi-admin-language";
      if (!window.localStorage.getItem(key)) {
        window.localStorage.setItem(key, "fa");
      }
    }
  },
};
