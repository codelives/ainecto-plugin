// The panel as a Claude artifact (beside the conversation in Claude web and desktop). Built into
// mcp-app/dist/ainecto-panel-artifact.html; publish it with the `mcp` capability naming the AiNecto
// connector and the tools the panel calls (see plugins/ainecto-panel/README.md).
import { createArtifactHost } from './artifact-host.js';
import { startPanel } from './panel.js';

startPanel(createArtifactHost(window.claude));
