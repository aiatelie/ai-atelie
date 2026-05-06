/* templates.ts — starter projects for the "New from template" dialog.
 *
 * Each template points at a route in the running app. Picking one opens
 * the editor on that route as the active tab. Add your own templates by
 * dropping starter files into the project and listing them here.
 */

export type Template = {
  id: string;
  label: string;
  description: string;
  route: string;
  thumbnail?: string;
};

export const TEMPLATES: Template[] = [];
