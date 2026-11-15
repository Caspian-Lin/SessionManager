import 'dart:io';
import 'dart:math' as math;
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_math_fork/flutter_math.dart';
import 'package:path/path.dart' as p;

import '../l10n/app_strings.dart';
import '../models.dart';
import '../theme.dart';
import 'gm3_surface.dart';

/// Clean editorial Markdown renderer modeled after Gemini's reading typography:
/// - Headings (`#`, `##`, `###`)
/// - Ordered (`1.`) and unordered (`-`, `*`) lists with clean hanging indents
/// - Inline `**bold**`, `*italic*`, `` `code` ``, and `\(...\)` spans
/// - Fenced code blocks and `$$...$$` display math blocks
class MarkdownProse extends StatefulWidget {
  final String text;
  final bool selectable;
  final bool showCopyButtons;
  final Color? textColor;
  final double? fontSize;

  const MarkdownProse({
    super.key,
    required this.text,
    this.selectable = true,
    this.showCopyButtons = true,
    this.textColor,
    this.fontSize,
  });

  @override
  State<MarkdownProse> createState() => _MarkdownProseState();

  static List<_MdSegment> _splitTopBlocks(String input) {
    final fenceRe = RegExp(r'```([a-zA-Z0-9_+-]*)[ \t]*\r?\n([\s\S]*?)```');
    final out = <_MdSegment>[];
    var pos = 0;
    for (final m in fenceRe.allMatches(input)) {
      if (m.start > pos) {
        _appendMathAware(input.substring(pos, m.start), out);
      }
      out.add(_MdSegment(
        kind: _MdSegmentKind.code,
        body: (m.group(2) ?? '').trimRight(),
        meta: (m.group(1) ?? '').trim(),
      ));
      pos = m.end;
    }
    if (pos < input.length) {
      _appendMathAware(input.substring(pos), out);
    }
    if (out.isEmpty) {
      out.add(_MdSegment(kind: _MdSegmentKind.prose, body: input));
    }
    return out;
  }

  static void _appendMathAware(String chunk, List<_MdSegment> out) {
    final mathRe = RegExp(r'(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])');
    var pos = 0;
    for (final m in mathRe.allMatches(chunk)) {
      if (m.start > pos) {
        final before = chunk.substring(pos, m.start).trim();
        if (before.isNotEmpty) {
          out.add(_MdSegment(kind: _MdSegmentKind.prose, body: before));
        }
      }
      final tex = (m.group(1) ?? m.group(2) ?? '').trim();
      if (tex.isNotEmpty) {
        out.add(_MdSegment(kind: _MdSegmentKind.math, body: tex));
      }
      pos = m.end;
    }
    if (pos < chunk.length) {
      final tail = chunk.substring(pos).trim();
      if (tail.isNotEmpty) {
        out.add(_MdSegment(kind: _MdSegmentKind.prose, body: tail));
      }
    }
  }
}

class _MarkdownProseState extends State<MarkdownProse> {
  bool _showRawSource = false;

  void _toggleRawSource() {
    if (!mounted) return;
    setState(() => _showRawSource = !_showRawSource);
  }

  @override
  Widget build(BuildContext context) {
    Widget body;
    if (_showRawSource) {
      body = _buildRawSourceView(context);
    } else {
      final segments = MarkdownProse._splitTopBlocks(widget.text);
      body = Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < segments.length; i++)
            _buildSegment(
              context,
              segments[i],
              isLast: i == segments.length - 1,
            ),
        ],
      );
    }

    if (!widget.selectable) {
      return body;
    }

    return SelectionArea(
      contextMenuBuilder: (ctx, selectableRegionState) {
        final s = AppStringsScope.of(ctx);
        final items = List<ContextMenuButtonItem>.of(
          selectableRegionState.contextMenuButtonItems,
        );
        items.add(
          ContextMenuButtonItem(
            label: _showRawSource ? s.showRenderedMarkdown : s.showRawMarkdown,
            onPressed: () {
              ContextMenuController.removeAny();
              selectableRegionState.hideToolbar();
              _toggleRawSource();
            },
          ),
        );
        items.add(
          ContextMenuButtonItem(
            label: s.copyRawMarkdown,
            onPressed: () {
              ContextMenuController.removeAny();
              selectableRegionState.hideToolbar();
              Clipboard.setData(ClipboardData(text: widget.text));
            },
          ),
        );
        return AdaptiveTextSelectionToolbar.buttonItems(
          anchors: selectableRegionState.contextMenuAnchors,
          buttonItems: items,
        );
      },
      child: body,
    );
  }

  Widget _buildRawSourceView(BuildContext context) {
    final s = AppStringsScope.of(context);
    final cs = Theme.of(context).colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final monoStyle = GoogleMaterialTheme.monoTextStyle(
      fontSize: widget.fontSize != null ? widget.fontSize! - 1.5 : Gm3.monoMd,
      height: 1.58,
      color: widget.textColor ?? cs.onSurface,
    );
    return Container(
      width: double.infinity,
      decoration: BoxDecoration(
        color: surfaces.card,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
        border: Border.all(color: surfaces.hairline.withOpacity(0.75)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SelectionContainer.disabled(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
              decoration: BoxDecoration(
                color: surfaces.hairline.withOpacity(0.45),
                borderRadius: const BorderRadius.vertical(
                  top: Radius.circular(Gm3.radiusMd),
                ),
              ),
              child: Row(
                children: [
                  Text(
                    'markdown · raw',
                    style: GoogleMaterialTheme.monoTextStyle(
                      fontSize: Gm3.monoSm,
                      fontWeight: FontWeight.w600,
                      color: cs.onSurfaceVariant,
                    ),
                  ),
                  const Spacer(),
                  InkWell(
                    onTap: _toggleRawSource,
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.auto_fix_high_rounded,
                            size: 13,
                            color: cs.primary,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            s.showRenderedMarkdown,
                            style: TextStyle(
                              fontSize: 11.5,
                              fontWeight: FontWeight.w500,
                              color: cs.primary,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                  const SizedBox(width: 4),
                  InkWell(
                    onTap: () =>
                        Clipboard.setData(ClipboardData(text: widget.text)),
                    borderRadius: BorderRadius.circular(6),
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: 8,
                        vertical: 2,
                      ),
                      child: Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Icon(
                            Icons.copy_rounded,
                            size: 13,
                            color: cs.onSurfaceVariant,
                          ),
                          const SizedBox(width: 4),
                          Text(
                            s.copyRawMarkdown,
                            style: TextStyle(
                              fontSize: 11.5,
                              color: cs.onSurfaceVariant,
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
          Padding(
            padding: const EdgeInsets.all(12),
            child: Text(widget.text, style: monoStyle),
          ),
        ],
      ),
    );
  }

  Widget _buildSegment(
    BuildContext context,
    _MdSegment seg, {
    required bool isLast,
  }) {
    switch (seg.kind) {
      case _MdSegmentKind.code:
        return MarkdownCodeBlock(
          code: seg.body,
          lang: seg.meta,
          selectable: widget.selectable,
          showCopyButton: widget.showCopyButtons,
          bottomSpacing: isLast ? 0 : 12,
        );
      case _MdSegmentKind.math:
        return _MathBlock(
          latex: seg.body,
          selectable: widget.selectable,
          isLast: isLast,
        );
      case _MdSegmentKind.prose:
        return _ProseLines(
          markdown: seg.body,
          selectable: widget.selectable,
          textColor: widget.textColor,
          fontSize: widget.fontSize,
          trimTrailingMargin: isLast,
        );
    }
  }
}

enum _MdSegmentKind { prose, code, math }

class _MdSegment {
  final _MdSegmentKind kind;
  final String body;
  final String? meta;
  const _MdSegment({required this.kind, required this.body, this.meta});
}

class _ProseLines extends StatelessWidget {
  final String markdown;
  final bool selectable;
  final Color? textColor;
  final double? fontSize;
  final bool trimTrailingMargin;

  const _ProseLines({
    required this.markdown,
    required this.selectable,
    this.textColor,
    this.fontSize,
    this.trimTrailingMargin = true,
  });

  static final RegExp _headingRe = RegExp(r'^(#{1,4})\s+(.+)$');
  static final RegExp _orderedRe = RegExp(r'^(\s*)(\d+)\.\s+(.+)$');
  static final RegExp _bulletRe = RegExp(r'^(\s*)[-*•]\s+(.+)$');
  static final RegExp _quoteRe = RegExp(r'^>\s?(.*)$');
  static final RegExp _hrRe =
      RegExp(r'^\s*(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$');
  static final RegExp _tableSepRe =
      RegExp(r'^\|?\s*:?-{2,}:?\s*(?:\|\s*:?-{2,}:?\s*)+\|?$|^\|?\s*:?-{2,}:?\s*\|?$');

  static List<String> _splitTableRow(String line) {
    var trimmed = line.trim();
    if (trimmed.startsWith('|')) trimmed = trimmed.substring(1);
    if (trimmed.endsWith('|')) {
      trimmed = trimmed.substring(0, trimmed.length - 1);
    }
    return trimmed.split('|').map((c) => c.trim()).toList();
  }

  static TextAlign _parseColAlign(String sepCell) {
    final t = sepCell.trim();
    final left = t.startsWith(':');
    final right = t.endsWith(':');
    if (left && right) return TextAlign.center;
    if (right) return TextAlign.right;
    return TextAlign.left;
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final baseColor = textColor ?? cs.onSurface;
    final baseStyle = theme.textTheme.bodyLarge!.copyWith(
      fontSize: fontSize ?? 15,
      height: 1.68,
      leadingDistribution: TextLeadingDistribution.even,
      color: baseColor,
    );

    final lines = markdown.split(RegExp(r'\r?\n'));
    final items = <({Widget child, double top, double bottom, double left, double right})>[];
    final paraBuf = <String>[];

    void flushParagraph() {
      if (paraBuf.isEmpty) return;
      final joined = paraBuf.join('\n').trim();
      paraBuf.clear();
      if (joined.isEmpty) return;
      items.add((
        child: _buildRichText(context, joined, baseStyle),
        top: 0,
        bottom: 10,
        left: 0,
        right: 0,
      ));
    }

    for (var idx = 0; idx < lines.length; idx++) {
      final line = lines[idx].trimRight();
      if (line.trim().isEmpty) {
        flushParagraph();
        continue;
      }

      // GFM Pipe Table: header line with `|` + separator line (`|---|`) + data rows
      if (line.contains('|') &&
          idx + 1 < lines.length &&
          _tableSepRe.hasMatch(lines[idx + 1].trim())) {
        flushParagraph();
        final headerCells = _splitTableRow(line);
        final sepCells = _splitTableRow(lines[idx + 1].trim());
        final colCount = headerCells.length > sepCells.length
            ? headerCells.length
            : sepCells.length;
        final alignments = [
          for (var c = 0; c < colCount; c++)
            c < sepCells.length ? _parseColAlign(sepCells[c]) : TextAlign.left,
        ];
        final rows = <List<String>>[];
        var nextIdx = idx + 2;
        while (nextIdx < lines.length) {
          final rowLine = lines[nextIdx].trim();
          if (rowLine.isEmpty || !rowLine.contains('|')) break;
          rows.add(_splitTableRow(rowLine));
          nextIdx++;
        }
        idx = nextIdx - 1;

        final borderColor = surfaces.hairline.withOpacity(0.65);
        final tableStyle = baseStyle.copyWith(fontSize: 13.5, height: 1.48);

        items.add((
          child: _MarkdownTableBlock(
            colCount: colCount,
            alignments: alignments,
            headerCells: headerCells,
            rows: rows,
            borderColor: borderColor,
            cardColor: surfaces.card,
            headerBgColor: surfaces.inset,
            selectable: selectable,
            buildCellText: (text, {bool isHeader = false}) => _buildRichText(
              context,
              text,
              isHeader
                  ? tableStyle.copyWith(fontWeight: FontWeight.w700)
                  : tableStyle,
            ),
          ),
          top: 4,
          bottom: 12,
          left: 0,
          right: 0,
        ));
        continue;
      }

      if (_hrRe.hasMatch(line)) {
        flushParagraph();
        items.add((
          child: Divider(
            height: 1,
            thickness: 1,
            color: surfaces.hairline.withOpacity(0.85),
          ),
          top: 8,
          bottom: 10,
          left: 0,
          right: 0,
        ));
        continue;
      }

      final hMatch = _headingRe.firstMatch(line);
      if (hMatch != null) {
        flushParagraph();
        final level = hMatch.group(1)!.length;
        final title = hMatch.group(2)!.trim();
        final size = switch (level) {
          1 => 20.0,
          2 => 17.5,
          3 => 16.0,
          _ => 15.0,
        };
        items.add((
          child: _buildRichText(
            context,
            title,
            baseStyle.copyWith(
              fontSize: size,
              fontWeight: FontWeight.w700,
              height: 1.38,
            ),
          ),
          top: 10,
          bottom: 8,
          left: 0,
          right: 0,
        ));
        continue;
      }

      final oMatch = _orderedRe.firstMatch(line);
      if (oMatch != null) {
        flushParagraph();
        final indent = (oMatch.group(1)!.length ~/ 2) * 16.0;
        final numLabel = '${oMatch.group(2)}.';
        final content = oMatch.group(3)!;
        items.add((
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 24,
                child: Text(
                  numLabel,
                  style: baseStyle.copyWith(fontWeight: FontWeight.w600),
                ),
              ),
              Expanded(child: _buildRichText(context, content, baseStyle)),
            ],
          ),
          top: 2,
          bottom: 8,
          left: indent,
          right: 0,
        ));
        continue;
      }

      final bMatch = _bulletRe.firstMatch(line);
      if (bMatch != null) {
        flushParagraph();
        final depth = bMatch.group(1)!.length ~/ 2;
        final indent = depth * 18.0 + 18.0;
        final content = bMatch.group(2)!;
        items.add((
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              SizedBox(
                width: 18,
                child: Text(
                  depth > 0 ? '◦' : '•',
                  style: baseStyle.copyWith(
                    fontWeight: FontWeight.w700,
                    color: baseColor.withOpacity(0.85),
                  ),
                ),
              ),
              Expanded(child: _buildRichText(context, content, baseStyle)),
            ],
          ),
          top: 2,
          bottom: 7,
          left: indent,
          right: 0,
        ));
        continue;
      }

      final qMatch = _quoteRe.firstMatch(line);
      if (qMatch != null) {
        flushParagraph();
        items.add((
          child: Container(
            padding: const EdgeInsets.fromLTRB(12, 6, 8, 6),
            decoration: BoxDecoration(
              border: Border(
                left: BorderSide(color: cs.primary.withOpacity(0.5), width: 3),
              ),
            ),
            child: _buildRichText(
              context,
              qMatch.group(1)!,
              baseStyle.copyWith(color: cs.onSurfaceVariant),
            ),
          ),
          top: 0,
          bottom: 10,
          left: 0,
          right: 0,
        ));
        continue;
      }

      paraBuf.add(line);
    }
    flushParagraph();

    final widgets = <Widget>[
      for (var i = 0; i < items.length; i++)
        Padding(
          padding: EdgeInsets.fromLTRB(
            items[i].left,
            i == 0 && trimTrailingMargin ? 0.0 : items[i].top,
            items[i].right,
            (i == items.length - 1 && trimTrailingMargin) ? 0.0 : items[i].bottom,
          ),
          child: items[i].child,
        ),
    ];

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: widgets,
    );
  }

  Widget _buildRichText(BuildContext context, String source, TextStyle baseStyle) {
    final span = TextSpan(style: baseStyle, children: _parseInlineSpans(context, source, baseStyle));
    final inSelectionArea = SelectionContainer.maybeOf(context) != null;
    if (selectable && !inSelectionArea) {
      return SelectableText.rich(span);
    }
    return Text.rich(span);
  }

  List<InlineSpan> _parseInlineSpans(BuildContext context, String source, TextStyle baseStyle) {
    final cs = Theme.of(context).colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final tokenRe = RegExp(
      r'\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|`([^`]+?)`|\\\((.+?)\\\)|\$([^\s$][^$\r\n]*?[^\s$]|[^\s$])\$|\*([^\s*][^*]*?[^\s*]|[^\s*])\*',
    );
    final spans = <InlineSpan>[];
    var pos = 0;

    for (final m in tokenRe.allMatches(source)) {
      if (m.start > pos) {
        spans.add(TextSpan(text: source.substring(pos, m.start)));
      }
      if (m.group(1) != null) {
        spans.add(TextSpan(
          text: m.group(1),
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            fontStyle: FontStyle.italic,
          ),
        ));
      } else if (m.group(2) != null) {
        spans.add(TextSpan(
          text: m.group(2),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ));
      } else if (m.group(3) != null) {
        spans.add(TextSpan(
          text: ' ${m.group(3)} ',
          style: GoogleMaterialTheme.monoTextStyle(
            fontSize: (baseStyle.fontSize ?? 15) - 1.5,
            color: cs.primary,
          ).copyWith(backgroundColor: surfaces.card),
        ));
      } else if (m.group(4) != null || m.group(5) != null) {
        final tex = (m.group(4) ?? m.group(5))!.trim();
        final resolvedColor =
            baseStyle.color ?? DefaultTextStyle.of(context).style.color ?? cs.onSurface;
        spans.add(WidgetSpan(
          alignment: PlaceholderAlignment.middle,
          child: Math.tex(
            tex,
            mathStyle: MathStyle.text,
            textStyle: baseStyle.copyWith(color: resolvedColor),
            onErrorFallback: (_) => Text(
              tex,
              style: GoogleMaterialTheme.monoTextStyle(
                fontSize: (baseStyle.fontSize ?? 15) - 1,
                color: cs.primary,
              ),
            ),
          ),
        ));
      } else if (m.group(6) != null) {
        spans.add(TextSpan(
          text: m.group(6),
          style: const TextStyle(fontStyle: FontStyle.italic),
        ));
      }
      pos = m.end;
    }
    if (pos < source.length) {
      spans.add(TextSpan(text: source.substring(pos)));
    }
    if (spans.isEmpty) {
      spans.add(TextSpan(text: source));
    }
    return spans;
  }
}

class CodeSyntaxHighlighter {
  static const int maxHighlightChars = 32768;

  static final RegExp _diffHeaderLineRe = RegExp(
    r'^(?:@@[^\r\n]*@@|diff --git [^\r\n]*|\+\+\+ [^\r\n]*|--- [^\r\n]*)',
    multiLine: true,
  );

  static final RegExp _codeTokenRe = RegExp(
    r'(?<comment>//[^\r\n]*|#[^\r\n]*|/\*[\s\S]*?\*/)'
    r'|(?<jsonkey>"(?:\\.|[^"\\\r\n])*"(?=\s*:))'
    r'|(?<string>"(?:\\.|[^"\\\r\n])*"|' "'" r'(?:\\.|[^' "'" r'\\\r\n])*' "'" r'|`[^`\r\n]*`)'
    r'|(?<path>https?://[^\s"' "'" r'`<>)\]]+|(?:[A-Za-z]:\\|/(?:Users|home|usr|var|tmp|etc|opt|packages|apps|src|lib|test)/)[^\s"' "'" r'`<>|]+)'
    r'|(?<flag>(?<=\s)--?[a-zA-Z][a-zA-Z0-9-]*)'
    r'|(?<keyword>\b(?:import|export|from|as|def|class|struct|enum|interface|type|extends|implements|fn|func|function|return|yield|const|let|var|final|static|async|await|try|catch|finally|throw|raise|new|if|else|elif|switch|case|default|for|while|do|in|of|break|continue|with|pass|lambda|pub|mut|impl|trait|match|use|mod|package|void|int|double|float|bool|boolean|string|str|dict|list|tuple|set|SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|ON|GROUP|ORDER|BY|LIMIT|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|TABLE|INDEX|AND|OR|NOT|NULL)\b)'
    r'|(?<constant>\b(?:true|false|null|nil|none|None|True|False|undefined|NaN|Infinity|self|this|super)\b)'
    r'|(?<number>\b(?:0x[0-9a-fA-F]+|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)',
    multiLine: true,
  );

  static final RegExp _diffTokenRe = RegExp(
    r'(?<diffmeta>^(?:@@[^\r\n]*@@|diff --git [^\r\n]*|\+\+\+ [^\r\n]*|--- [^\r\n]*)$)'
    r'|(?<diffadd>^\+[^\r\n]*$)'
    r'|(?<diffdel>^-[^\r\n]*$)',
    multiLine: true,
  );

  static bool _looksLikeDiff(String source, String? language) {
    final lang = language?.toLowerCase().trim();
    if (lang == 'diff' || lang == 'patch') return true;
    return _diffHeaderLineRe.hasMatch(source);
  }

  static TextSpan buildSpan(
    String source,
    TextStyle baseStyle, {
    required bool isDark,
    String? language,
  }) {
    if (source.isEmpty) return TextSpan(text: source, style: baseStyle);

    final commentColor =
        isDark ? const Color(0xFF8B949E) : const Color(0xFF6E7781);
    final keyColor =
        isDark ? const Color(0xFF79C0FF) : const Color(0xFF0550AE);
    final stringColor =
        isDark ? const Color(0xFF8EE59E) : const Color(0xFF116329);
    final pathColor =
        isDark ? const Color(0xFFA5D6FF) : const Color(0xFF0969DA);
    final flagColor =
        isDark ? const Color(0xFFF2CC60) : const Color(0xFF9A6700);
    final keywordColor =
        isDark ? const Color(0xFFD2A8FF) : const Color(0xFF8250DF);
    final numberColor =
        isDark ? const Color(0xFFFFA657) : const Color(0xFFBC4C00);
    final diffAddColor =
        isDark ? const Color(0xFF7EE787) : const Color(0xFF116329);
    final diffAddBg =
        isDark ? const Color(0x222EA043) : const Color(0x1E2DA44E);
    final diffDelColor =
        isDark ? const Color(0xFFFF7B72) : const Color(0xFFCF222E);
    final diffDelBg =
        isDark ? const Color(0x22F85149) : const Color(0x1ECF222E);

    final head = source.length > maxHighlightChars
        ? source.substring(0, maxHighlightChars)
        : source;
    final tail =
        source.length > maxHighlightChars ? source.substring(maxHighlightChars) : '';

    final children = <InlineSpan>[];

    if (_looksLikeDiff(head, language)) {
      var pos = 0;
      for (final m in _diffTokenRe.allMatches(head)) {
        if (m.start > pos) {
          children.addAll(_tokenizeCode(
            head.substring(pos, m.start),
            commentColor: commentColor,
            keyColor: keyColor,
            stringColor: stringColor,
            pathColor: pathColor,
            flagColor: flagColor,
            keywordColor: keywordColor,
            numberColor: numberColor,
          ));
        }
        final tok = m.group(0)!;
        if (m.namedGroup('diffmeta') != null) {
          children.add(TextSpan(
            text: tok,
            style: TextStyle(color: keywordColor, fontWeight: FontWeight.w600),
          ));
        } else if (m.namedGroup('diffadd') != null) {
          children.add(TextSpan(
            text: tok,
            style: TextStyle(color: diffAddColor, backgroundColor: diffAddBg),
          ));
        } else {
          children.add(TextSpan(
            text: tok,
            style: TextStyle(color: diffDelColor, backgroundColor: diffDelBg),
          ));
        }
        pos = m.end;
      }
      if (pos < head.length) {
        children.addAll(_tokenizeCode(
          head.substring(pos),
          commentColor: commentColor,
          keyColor: keyColor,
          stringColor: stringColor,
          pathColor: pathColor,
          flagColor: flagColor,
          keywordColor: keywordColor,
          numberColor: numberColor,
        ));
      }
    } else {
      children.addAll(_tokenizeCode(
        head,
        commentColor: commentColor,
        keyColor: keyColor,
        stringColor: stringColor,
        pathColor: pathColor,
        flagColor: flagColor,
        keywordColor: keywordColor,
        numberColor: numberColor,
      ));
    }

    if (tail.isNotEmpty) {
      children.add(TextSpan(text: tail));
    }
    return TextSpan(style: baseStyle, children: children);
  }

  static List<InlineSpan> _tokenizeCode(
    String input, {
    required Color commentColor,
    required Color keyColor,
    required Color stringColor,
    required Color pathColor,
    required Color flagColor,
    required Color keywordColor,
    required Color numberColor,
  }) {
    final spans = <InlineSpan>[];
    var pos = 0;
    for (final m in _codeTokenRe.allMatches(input)) {
      if (m.start > pos) {
        spans.add(TextSpan(text: input.substring(pos, m.start)));
      }
      final tok = m.group(0)!;
      TextStyle? tokStyle;
      if (m.namedGroup('comment') != null) {
        tokStyle = TextStyle(color: commentColor, fontStyle: FontStyle.italic);
      } else if (m.namedGroup('jsonkey') != null) {
        tokStyle = TextStyle(color: keyColor, fontWeight: FontWeight.w600);
      } else if (m.namedGroup('string') != null) {
        tokStyle = TextStyle(color: stringColor);
      } else if (m.namedGroup('path') != null) {
        tokStyle = TextStyle(color: pathColor);
      } else if (m.namedGroup('flag') != null) {
        tokStyle = TextStyle(color: flagColor);
      } else if (m.namedGroup('keyword') != null) {
        tokStyle = TextStyle(color: keywordColor, fontWeight: FontWeight.w600);
      } else if (m.namedGroup('constant') != null || m.namedGroup('number') != null) {
        tokStyle = TextStyle(color: numberColor);
      }
      spans.add(TextSpan(text: tok, style: tokStyle));
      pos = m.end;
    }
    if (pos < input.length) {
      spans.add(TextSpan(text: input.substring(pos)));
    }
    return spans;
  }
}

class SyntaxHighlightedCodeText extends StatelessWidget {
  final String text;
  final TextStyle style;
  final String? language;
  final bool selectable;

  const SyntaxHighlightedCodeText({
    super.key,
    required this.text,
    required this.style,
    this.language,
    this.selectable = true,
  });

  @override
  Widget build(BuildContext context) {
    final isDark = Theme.of(context).brightness == Brightness.dark;
    final span = CodeSyntaxHighlighter.buildSpan(
      text,
      style,
      isDark: isDark,
      language: language,
    );
    final inSelectionArea = SelectionContainer.maybeOf(context) != null;
    if (selectable && !inSelectionArea) {
      return SelectableText.rich(span);
    }
    return Text.rich(span);
  }
}

class MarkdownCodeBlock extends StatelessWidget {
  final String code;
  final String? lang;
  final bool selectable;
  final bool showCopyButton;
  final double bottomSpacing;

  const MarkdownCodeBlock({
    super.key,
    required this.code,
    this.lang,
    this.selectable = true,
    this.showCopyButton = true,
    this.bottomSpacing = 12,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final label = (lang == null || lang!.isEmpty) ? 'code' : lang!;
    final mono = GoogleMaterialTheme.monoTextStyle(
      fontSize: Gm3.monoMd,
      color: cs.onSurface,
      height: 1.55,
    );

    return Padding(
      padding: EdgeInsets.only(bottom: bottomSpacing),
      child: Gm3Surface.rounded(
        radius: Gm3.radiusMd,
        clip: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            SelectionContainer.disabled(
              child: Container(
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 7),
                decoration: BoxDecoration(
                  color: surfaces.hairline.withOpacity(0.45),
                ),
                child: Row(
                  children: [
                    Expanded(
                      child: Text(
                        label,
                        overflow: TextOverflow.ellipsis,
                        style: GoogleMaterialTheme.monoTextStyle(
                          fontSize: Gm3.monoSm,
                          color: cs.onSurfaceVariant,
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                    if (showCopyButton)
                      InkWell(
                        borderRadius: BorderRadius.circular(Gm3.radiusXs),
                        onTap: () {
                          Clipboard.setData(ClipboardData(text: code));
                          ScaffoldMessenger.of(context).showSnackBar(
                            SnackBar(
                              content: Text(
                                AppStringsScope.of(context).codeCopied,
                                style: theme.textTheme.bodyMedium,
                              ),
                              duration: const Duration(seconds: 1),
                              behavior: SnackBarBehavior.floating,
                            ),
                          );
                        },
                        child: Padding(
                          padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 2),
                          child: Row(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(Icons.copy_rounded, size: 13, color: cs.onSurfaceVariant),
                              const SizedBox(width: 4),
                              Text(
                                AppStringsScope.of(context).copyCode,
                                style: theme.textTheme.labelSmall,
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(12),
              child: SyntaxHighlightedCodeText(
                text: code,
                style: mono,
                language: lang,
                selectable: selectable,
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MathBlock extends StatelessWidget {
  final String latex;
  final bool selectable;
  final bool isLast;
  const _MathBlock({
    required this.latex,
    required this.selectable,
    this.isLast = false,
  });

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final resolvedTextColor =
        DefaultTextStyle.of(context).style.color ?? cs.onSurface;
    final isLightTextContext = Theme.of(context).brightness == Brightness.dark &&
        resolvedTextColor.computeLuminance() < 0.4;
    final cardBg = isLightTextContext
        ? resolvedTextColor.withOpacity(0.06)
        : Gm3Surfaces.of(context).card;
    final fallbackStyle = GoogleMaterialTheme.monoTextStyle(
      fontSize: Gm3.monoMd,
      color: cs.primary,
    );
    return Container(
      width: double.infinity,
      margin: EdgeInsets.only(top: isLast ? 0 : 8, bottom: isLast ? 0 : 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 12),
      decoration: BoxDecoration(
        color: cardBg,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
      ),
      child: SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        child: Math.tex(
          latex,
          mathStyle: MathStyle.display,
          textStyle: TextStyle(
            fontSize: 15.5,
            color: resolvedTextColor,
          ),
          onErrorFallback: (_) => (selectable && SelectionContainer.maybeOf(context) == null)
              ? SelectableText(latex, style: fallbackStyle)
              : Text(latex, style: fallbackStyle),
        ),
      ),
    );
  }
}

/// Compact rounded attachment/source capsule inspired by Gemini's inline chips
/// (e.g. `Lecture01.pdf` or `Lecture08.pdf + 3`) with a click popover card.
class AttachmentChipGroup extends StatelessWidget {
  final List<ViewBlock> attachmentBlocks;
  final File? Function(String sha) resolveBlobFile;

  const AttachmentChipGroup({
    super.key,
    required this.attachmentBlocks,
    required this.resolveBlobFile,
  });

  String _blockDisplayName(ViewBlock block) {
    final raw = (block.text ?? '').trim();
    if (raw.isNotEmpty) {
      final base = p.basename(raw);
      if (base.isNotEmpty && base.length <= 44) return base;
      if (raw.length <= 44) return raw;
      return '${raw.substring(0, 41)}...';
    }
    if (block.blobSha256 != null) {
      final shortSha = block.blobSha256!.length > 10
          ? block.blobSha256!.substring(0, 10)
          : block.blobSha256!;
      return '${block.type}_$shortSha';
    }
    return block.type;
  }

  @override
  Widget build(BuildContext context) {
    if (attachmentBlocks.isEmpty) return const SizedBox.shrink();
    final primary = attachmentBlocks.first;
    final extraCount = attachmentBlocks.length - 1;
    final label = extraCount > 0
        ? '${_blockDisplayName(primary)} + $extraCount'
        : _blockDisplayName(primary);
    final surfaces = Gm3Surfaces.of(context);
    final cs = Theme.of(context).colorScheme;
    final theme = Theme.of(context);

    return MenuAnchor(
      style: MenuStyle(
        backgroundColor: WidgetStatePropertyAll(surfaces.card),
        elevation: const WidgetStatePropertyAll(4),
        shape: WidgetStatePropertyAll(
          RoundedRectangleBorder(borderRadius: BorderRadius.circular(Gm3.radiusMd)),
        ),
        padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(vertical: 8)),
      ),
      menuChildren: [
        for (final block in attachmentBlocks)
          _AttachmentMenuEntry(
            block: block,
            title: _blockDisplayName(block),
            file: block.blobSha256 != null ? resolveBlobFile(block.blobSha256!) : null,
          ),
      ],
      builder: (context, controller, child) {
        return InkWell(
          borderRadius: BorderRadius.circular(8),
          onTap: () {
            if (controller.isOpen) {
              controller.close();
            } else {
              controller.open();
            }
          },
          child: Container(
            padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 4),
            decoration: BoxDecoration(
              color: surfaces.card,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(
                  primary.type == 'image' ? Icons.image_outlined : Icons.description_outlined,
                  size: 13,
                  color: cs.onSurfaceVariant,
                ),
                const SizedBox(width: 5),
                Text(
                  label,
                  style: theme.textTheme.labelSmall?.copyWith(
                    color: cs.onSurfaceVariant,
                    fontWeight: FontWeight.w500,
                  ),
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _AttachmentMenuEntry extends StatelessWidget {
  final ViewBlock block;
  final String title;
  final File? file;

  const _AttachmentMenuEntry({
    required this.block,
    required this.title,
    required this.file,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final exists = file != null && file!.existsSync();
    final isPdf = title.toLowerCase().endsWith('.pdf');
    final badgeText = isPdf ? 'PDF' : block.type.toUpperCase();

    return InkWell(
      onTap: exists && Platform.isWindows
          ? () {
              Process.run('explorer.exe', ['/select,', file!.path]);
              Navigator.maybePop(context);
            }
          : null,
      child: ConstrainedBox(
        constraints: const BoxConstraints(minWidth: 230, maxWidth: 320),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Row(
                children: [
                  Container(
                    padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 1),
                    decoration: BoxDecoration(
                      color: isPdf ? const Color(0xFFD93025) : cs.primary,
                      borderRadius: BorderRadius.circular(4),
                    ),
                    child: Text(
                      badgeText,
                      style: theme.textTheme.labelSmall?.copyWith(
                        color: Colors.white,
                        fontSize: 10,
                        fontWeight: FontWeight.w700,
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      exists
                          ? AppStringsScope.of(context).openMediaFile
                          : AppStringsScope.of(context).mediaFileMissing,
                      style: theme.textTheme.labelSmall?.copyWith(color: cs.onSurfaceVariant),
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ],
              ),
              const SizedBox(height: 6),
              Text(
                title,
                style: theme.textTheme.titleSmall?.copyWith(fontWeight: FontWeight.w600),
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
        ),
      ),
    );
  }
}

class _MarkdownTableBlock extends StatefulWidget {
  final int colCount;
  final List<TextAlign> alignments;
  final List<String> headerCells;
  final List<List<String>> rows;
  final Color borderColor;
  final Color cardColor;
  final Color headerBgColor;
  final bool selectable;
  final Widget Function(String text, {bool isHeader}) buildCellText;

  const _MarkdownTableBlock({
    required this.colCount,
    required this.alignments,
    required this.headerCells,
    required this.rows,
    required this.borderColor,
    required this.cardColor,
    required this.headerBgColor,
    required this.selectable,
    required this.buildCellText,
  });

  @override
  State<_MarkdownTableBlock> createState() => _MarkdownTableBlockState();
}

class _MarkdownTableBlockState extends State<_MarkdownTableBlock> {
  final ScrollController _hScrollCtrl = ScrollController();

  @override
  void dispose() {
    _hScrollCtrl.dispose();
    super.dispose();
  }

  Alignment _alignFor(int col) {
    if (col >= widget.alignments.length) return Alignment.centerLeft;
    return switch (widget.alignments[col]) {
      TextAlign.right => Alignment.centerRight,
      TextAlign.center => Alignment.center,
      _ => Alignment.centerLeft,
    };
  }

  Widget _buildTable(double tableWidth, {int startCol = 0, int? endCol}) {
    final end = endCol ?? widget.colCount;
    return Container(
      width: tableWidth,
      decoration: BoxDecoration(
        color: widget.cardColor,
        borderRadius: BorderRadius.circular(Gm3.radiusSm),
        border: Border.all(color: widget.borderColor),
      ),
      clipBehavior: Clip.antiAlias,
      child: Table(
        defaultColumnWidth: const FlexColumnWidth(),
        border: TableBorder(
          horizontalInside: BorderSide(color: widget.borderColor, width: 0.8),
          verticalInside: BorderSide(color: widget.borderColor, width: 0.8),
        ),
        children: [
          TableRow(
            decoration: BoxDecoration(color: widget.headerBgColor),
            children: [
              for (var c = startCol; c < end; c++)
                Padding(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
                  child: Align(
                    alignment: _alignFor(c),
                    child: widget.buildCellText(
                      c < widget.headerCells.length ? widget.headerCells[c] : '',
                      isHeader: true,
                    ),
                  ),
                ),
            ],
          ),
          for (final row in widget.rows)
            TableRow(
              children: [
                for (var c = startCol; c < end; c++)
                  Padding(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 10, vertical: 7),
                    child: Align(
                      alignment: _alignFor(c),
                      child: widget.buildCellText(
                        c < row.length ? row[c] : '',
                      ),
                    ),
                  ),
              ],
            ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, constraints) {
        final maxW = constraints.maxWidth.isFinite ? constraints.maxWidth : 680.0;
        if (!widget.selectable) {
          const minStaticColWidth = 76.0;
          if (widget.colCount * minStaticColWidth <= maxW) {
            return _buildTable(maxW);
          }
          // Too many columns to fit even with auto-wrapping: split into multiple horizontal table chunks.
          final colsPerChunk = math.max(1, (maxW / minStaticColWidth).floor());
          final chunks = <Widget>[];
          for (var start = 0; start < widget.colCount; start += colsPerChunk) {
            final end = math.min(widget.colCount, start + colsPerChunk);
            if (chunks.isNotEmpty) {
              chunks.add(const SizedBox(height: 6));
            }
            chunks.add(_buildTable(maxW, startCol: start, endCol: end));
          }
          return Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: chunks,
          );
        }

        const minReadableColWidth = 110.0;
        final desiredWidth = widget.colCount * minReadableColWidth;
        final needsHScroll = desiredWidth > maxW;
        final tableWidth = needsHScroll ? math.max(maxW, desiredWidth) : maxW;

        final table = _buildTable(tableWidth);
        if (!needsHScroll) {
          return table;
        }
        return Scrollbar(
          controller: _hScrollCtrl,
          thumbVisibility: true,
          child: SingleChildScrollView(
            controller: _hScrollCtrl,
            scrollDirection: Axis.horizontal,
            padding: const EdgeInsets.only(bottom: 10),
            child: table,
          ),
        );
      },
    );
  }
}
