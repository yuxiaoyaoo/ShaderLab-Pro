import type { GraphDocument } from '../graph/model';
import { serializeGraphDocument } from './graphIO';

export interface TextExportArtifact { fileName: string; contents: string }

export function safeExportBaseName(value: string, fallback = 'shader'): string {
  const safe = (value.trim() || fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .replace(/[. ]+$/g, '')
    .slice(0, 96);
  return safe || fallback;
}

export function fragmentExportArtifact(projectName: string, pass: string, source: string): TextExportArtifact {
  return { fileName: `${safeExportBaseName(projectName)}-${safeExportBaseName(pass, 'image')}.frag`, contents: source.endsWith('\n') ? source : `${source}\n` };
}

export function graphJsonExportArtifact(projectName: string, document: GraphDocument): TextExportArtifact {
  return {
    fileName: `${safeExportBaseName(projectName)}-${safeExportBaseName(document.pass)}.shadergraph.json`,
    contents: serializeGraphDocument(document),
  };
}
