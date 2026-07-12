import type { ReactNode } from 'react';

export function MarkdownContent({
  className,
  testId,
  text,
}: {
  readonly className?: string;
  readonly testId?: string;
  readonly text: string;
}) {
  return (
    <div className={className} data-testid={testId}>
      {markdownBlocks(text)}
    </div>
  );
}

function markdownBlocks(text: string) {
  const blocks: ReactNode[] = [];
  const paragraph: string[] = [];
  let listItems: { readonly key: number; readonly text: string }[] = [];
  let orderedItems: { readonly key: number; readonly text: string }[] = [];
  let itemKey = 0;

  function flushParagraph() {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(<p key={`p-${blocks.length}`}>{inlineMarkdown(paragraph.join('\n'))}</p>);
    paragraph.length = 0;
  }

  function flushUnorderedList() {
    if (listItems.length === 0) {
      return;
    }
    blocks.push(
      <ul key={`ul-${blocks.length}`}>
        {listItems.map((item) => (
          <li key={item.key}>{inlineMarkdown(item.text)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  }

  function flushOrderedList() {
    if (orderedItems.length === 0) {
      return;
    }
    blocks.push(
      <ol key={`ol-${blocks.length}`}>
        {orderedItems.map((item) => (
          <li key={item.key}>{inlineMarkdown(item.text)}</li>
        ))}
      </ol>,
    );
    orderedItems = [];
  }

  function flushLists() {
    flushUnorderedList();
    flushOrderedList();
  }

  for (const line of text.split(/\r?\n/)) {
    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const heading = line.match(/^(#{1,3})\s+(.+)$/);

    if (!line.trim()) {
      flushParagraph();
      flushLists();
      continue;
    }
    if (heading) {
      const headingLevel = heading[1];
      const headingText = heading[2];
      if (!headingLevel || !headingText) {
        continue;
      }
      flushParagraph();
      flushLists();
      const HeadingTag = `h${headingLevel.length + 3}` as 'h4' | 'h5' | 'h6';
      blocks.push(
        <HeadingTag key={`h-${blocks.length}`}>{inlineMarkdown(headingText)}</HeadingTag>,
      );
      continue;
    }
    if (unordered) {
      const item = unordered[1];
      if (!item) {
        continue;
      }
      flushParagraph();
      flushOrderedList();
      listItems.push({ key: itemKey, text: item });
      itemKey += 1;
      continue;
    }
    if (ordered) {
      const item = ordered[1];
      if (!item) {
        continue;
      }
      flushParagraph();
      flushUnorderedList();
      orderedItems.push({ key: itemKey, text: item });
      itemKey += 1;
      continue;
    }
    flushLists();
    paragraph.push(line);
  }

  flushParagraph();
  flushLists();

  return blocks.length ? blocks : <p>{text}</p>;
}

function inlineMarkdown(text: string) {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\))/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  match = pattern.exec(text);
  while (match) {
    if (match.index > lastIndex) {
      nodes.push(text.slice(lastIndex, match.index));
    }
    if (match[2]) {
      nodes.push(<strong key={`strong-${match.index}`}>{match[2]}</strong>);
    } else if (match[3]) {
      nodes.push(<code key={`code-${match.index}`}>{match[3]}</code>);
    } else if (match[4] && match[5]) {
      nodes.push(
        <a href={match[5]} key={`link-${match.index}`} rel="noreferrer noopener" target="_blank">
          {match[4]}
        </a>,
      );
    }
    lastIndex = pattern.lastIndex;
    match = pattern.exec(text);
  }

  if (lastIndex < text.length) {
    nodes.push(text.slice(lastIndex));
  }

  return nodes;
}
