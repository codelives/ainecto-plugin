// The panel as a Claude artifact (beside the conversation in Claude web and desktop). Built into
// mcp-app/dist/ainecto-panel-artifact.html with an empty project slot; scripts/export-artifact.mjs fills the slot
// with one project's uuid and writes the manifest to publish it with (see plugins/ainecto-panel/README.md).
import { createArtifactHost } from './artifact-host.js';
import { startPanel } from './panel.js';
import { projectUuidOf } from '../plugins/ainecto-panel/hooks/inbox.js';

/** The project this page was exported for: the JSON slot the export fills (null in the unfilled build). */
function exportedProject() {
  try {
    return projectUuidOf(JSON.parse(document.getElementById('ainecto-project')?.textContent ?? 'null')?.projectUuid);
  } catch {
    return null;
  }
}

document.documentElement.dataset.host = 'artifact';
startPanel(createArtifactHost(window.claude, { projectUuid: exportedProject() }));
