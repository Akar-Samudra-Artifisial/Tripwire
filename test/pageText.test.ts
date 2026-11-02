import { describe, expect, it } from 'vitest';
import { storageToText, TRUNCATED_MARK } from '../src/core/pageText';

describe('storageToText', () => {
  it('drops macros and their parameters but keeps rich-text bodies', () => {
    const xhtml =
      '<p>Intro</p>' +
      '<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">js</ac:parameter><ac:plain-text-body><![CDATA[secret()]]></ac:plain-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Hidden title</ac:parameter><ac:rich-text-body><p>Visible note</p></ac:rich-text-body></ac:structured-macro>' +
      '<ac:structured-macro ac:name="toc" />' +
      '<p>Outro</p>';
    const text = storageToText(xhtml);
    expect(text).toContain('Intro');
    expect(text).toContain('Visible note');
    expect(text).toContain('Outro');
    expect(text).not.toContain('secret');
    expect(text).not.toContain('Hidden title');
    expect(text).not.toContain('js');
  });

  it('turns list items into "- " lines and table cells into " | "', () => {
    const text = storageToText('<ul><li>one</li><li>two</li></ul><table><tr><th>a</th><td>b</td></tr></table>');
    expect(text).toContain('- one\n- two');
    expect(text).toContain('| a | b');
    expect(storageToText('<ul><li><p>one</p></li><li><p>two</p></li></ul><p>after</p>')).toBe('- one\n- two\nafter');
  });

  it('decodes entities', () => {
    expect(storageToText('<p>Fewer&nbsp;than 10 &amp; &lt;b&gt; &quot;q&quot; &#39;s&#39; &#8217; &#x2014;</p>')).toBe(
      'Fewer than 10 & <b> "q" \'s\' ’ —',
    );
  });

  it('cuts at maxChars with a truncation mark', () => {
    const text = storageToText(`<p>${'x'.repeat(50)}</p>`, 10);
    expect(text).toBe(`${'x'.repeat(10)}${TRUNCATED_MARK}`);
  });
});
