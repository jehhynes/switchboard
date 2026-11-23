# GitHub Markdown sample

A document that uses every GitHub-flavoured feature the page draws. See [Alerts](#alerts) and the footnote at the end.[^why]

## Lists

- Root bullets are solid discs
  - The second level is a hollow circle
    - The third level is a square
- Back at the root

1. Ordered lists number
   - with a bullet list inside
2. and carry on

### Task list

- [x] Read the cheat sheet
- [ ] Draw every feature
  - [ ] Nested task

## Text

**Bold**, *italic*, ~~strikethrough~~, `inline code`, H<sub>2</sub>O and E = mc<sup>2</sup>.
Press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>P</kbd> to open the palette.<br>This line follows a `<br>`.
A line ending in two spaces  
breaks too, and so does a backslash\
like this.

Emoji shortcodes: :+1: :sparkles: :rocket: :warning:

Autolinks: https://github.com and www.example.com, and mail to someone@example.com.

<!-- A comment GitHub hides. -->

## Alerts

> [!NOTE]
> Useful information that users should know, even when skimming.

> [!TIP]
> Helpful advice for doing things better or more easily.

> [!IMPORTANT]
> Key information users need to know to achieve their goal.

> [!WARNING]
> Urgent info that needs immediate user attention to avoid problems.

> [!CAUTION]
> Advises about risks or negative outcomes of certain actions.

> A plain quote stays a quote.

## Table

| Left | Center | Right |
|:-----|:------:|------:|
| a    |   b    |     1 |
| long left cell | centred | 1,234 |

## Code

```ts
const answer: number = 42;
```

```diff
@@ -1,3 +1,3 @@
 unchanged line
- removed line
+ added line
```

## Collapsible sections

<details>
<summary>Click to expand</summary>

Hidden **Markdown** content, with a list:

- one
- two

<details>
<summary>A nested section</summary>

Nested content with `code`.

</details>

</details>

<details open>
<summary>Open from the start</summary>

This one starts open.

</details>

---

Back to the [top](#github-markdown-sample).

[^why]: Footnotes collect at the end, with a link back to where they were cited.
