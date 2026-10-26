// The panel as a Claude artifact (beside the conversation in Claude web and desktop). Built into
// mcp-app/dist/ainecto-panel-artifact.html with an empty project slot and its version slot; ainecto-api fills the
// project slot with one project's uuid and hands the page with its capabilities to Claude (open_ainecto_panel with
// artifactPage, KAN-406; see plugins/ainecto-panel/README.md).
import { createArtifactHost } from './artifact-host.js';
import { startPanel } from './panel.js';
import { projectUuidOf } from '../plugins/ainecto-panel/hooks/inbox.js';

/** A JSON slot the build or the export filled (null when absent or unreadable). */
function slot(id) {
  try {
    return JSON.parse(document.getElementById(id)?.textContent ?? 'null');
  } catch {
    return null;
  }
}

const version = slot('ainecto-panel-version');

document.documentElement.dataset.host = 'artifact';
startPanel(
  createArtifactHost(window.claude, {
    projectUuid: projectUuidOf(slot('ainecto-project')?.projectUuid),
    version: typeof version === 'string' && version ? version : null,
  }),
);
