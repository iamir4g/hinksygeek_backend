import type { Core } from '@strapi/strapi';

const PUBLIC_ACTIONS = ['find', 'findOne'] as const;

async function enablePublicContentApi(strapi: Core.Strapi) {
  const roleService = strapi.plugin('users-permissions').service('role');
  const roles = await roleService.find();
  const publicRole = roles.find((role: { type: string }) => role.type === 'public');
  if (!publicRole) return;

  const role = await roleService.findOne(publicRole.id);
  if (!role?.permissions) return;

  let changed = false;
  for (const [apiKey, apiValue] of Object.entries(
    role.permissions as Record<string, { controllers?: Record<string, Record<string, { enabled?: boolean }>> }>,
  )) {
    if (!apiKey.startsWith('api::')) continue;
    const controllers = apiValue?.controllers ?? {};
    for (const controller of Object.values(controllers)) {
      for (const action of PUBLIC_ACTIONS) {
        if (controller[action] && controller[action].enabled !== true) {
          controller[action].enabled = true;
          changed = true;
        }
      }
    }
  }

  if (changed) {
    await roleService.updateRole(publicRole.id, role);
    strapi.log.info('Public API permissions enabled for all content types.');
  }
}

export default {
  register() {},

  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    try {
      await enablePublicContentApi(strapi);
    } catch (err) {
      strapi.log.warn(`Could not sync public permissions: ${err}`);
    }
  },
};
