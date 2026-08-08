import type { DocumentLoader } from '@fedify/vocab-runtime';
import { getDocumentLoader } from '@fedify/vocab-runtime';

/** Production-safe document loader with a `loadDocument` alias for contract tests. */
export type ProductionSafeDocumentLoader = DocumentLoader & {
  loadDocument: DocumentLoader;
};

/** Creates the production-safe Fedify document loader with private-address blocking enabled. */
export function createProductionSafeDocumentLoader(): ProductionSafeDocumentLoader {
  const loader = getDocumentLoader({
    allowPrivateAddress: false,
    maxRedirection: 5,
  });
  return Object.assign(loader, { loadDocument: loader });
}
