import 'dart:io';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
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
class MarkdownProse extends StatelessWidget {
  final String text;
  final bool selectable;
  final bool showCopyButtons;
  final Color? textColor;

  const MarkdownProse({
    super.key,
    required this.text,
    this.selectable = true,
    this.showCopyButtons = true,
    this.textColor,
  });

  @override
  Widget build(BuildContext context) {
    final segments = _splitTopBlocks(text);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        for (var i = 0; i < segments.length; i++) _buildSegment(context, segments[i]),
      ],
    );
  }

  Widget _buildSegment(BuildContext context, _MdSegment seg) {
    switch (seg.kind) {
      case _MdSegmentKind.code:
        return MarkdownCodeBlock(
          code: seg.body,
          lang: seg.meta,
          selectable: selectable,
          showCopyButton: showCopyButtons,
        );
      case _MdSegmentKind.math:
        return _MathBlock(
          latex: seg.body,
          selectable: selectable,
        );
      case _MdSegmentKind.prose:
        return _ProseLines(
          markdown: seg.body,
          selectable: selectable,
          textColor: textColor,
        );
    }
  }

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
    final mathRe = RegExp(r'\$\$([\s\S]+?)\$\$');
    var pos = 0;
    for (final m in mathRe.allMatches(chunk)) {
      if (m.start > pos) {
        final before = chunk.substring(pos, m.start).trim();
        if (before.isNotEmpty) {
          out.add(_MdSegment(kind: _MdSegmentKind.prose, body: before));
        }
      }
      out.add(_MdSegment(kind: _MdSegmentKind.math, body: m.group(1)!.trim()));
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

  const _ProseLines({
    required this.markdown,
    required this.selectable,
    this.textColor,
  });

  static final RegExp _headingRe = RegExp(r'^(#{1,4})\s+(.+)$');
  static final RegExp _orderedRe = RegExp(r'^(\s*)(\d+)\.\s+(.+)$');
  static final RegExp _bulletRe = RegExp(r'^(\s*)[-*•]\s+(.+)$');
  static final RegExp _quoteRe = RegExp(r'^>\s?(.*)$');

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final cs = theme.colorScheme;
    final baseColor = textColor ?? cs.onSurface;
    final baseStyle = theme.textTheme.bodyLarge!.copyWith(
      fontSize: 15,
      height: 1.68,
      color: baseColor,
    );

    final lines = markdown.split(RegExp(r'\r?\n'));
    final widgets = <Widget>[];
    final paraBuf = <String>[];

    void flushParagraph() {
      if (paraBuf.isEmpty) return;
      final joined = paraBuf.join('\n').trim();
      paraBuf.clear();
      if (joined.isEmpty) return;
      widgets.add(
        Padding(
          padding: const EdgeInsets.only(bottom: 10),
          child: _buildRichText(context, joined, baseStyle),
        ),
      );
    }

    for (final rawLine in lines) {
      final line = rawLine.trimRight();
      if (line.trim().isEmpty) {
        flushParagraph();
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
        widgets.add(
          Padding(
            padding: const EdgeInsets.only(top: 10, bottom: 8),
            child: _buildRichText(
              context,
              title,
              baseStyle.copyWith(
                fontSize: size,
                fontWeight: FontWeight.w700,
                height: 1.38,
              ),
            ),
          ),
        );
        continue;
      }

      final oMatch = _orderedRe.firstMatch(line);
      if (oMatch != null) {
        flushParagraph();
        final indent = (oMatch.group(1)!.length ~/ 2) * 16.0;
        final numLabel = '${oMatch.group(2)}.';
        final content = oMatch.group(3)!;
        widgets.add(
          Padding(
            padding: EdgeInsets.fromLTRB(indent, 2, 0, 8),
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
          ),
        );
        continue;
      }

      final bMatch = _bulletRe.firstMatch(line);
      if (bMatch != null) {
        flushParagraph();
        final depth = bMatch.group(1)!.length ~/ 2;
        final indent = depth * 18.0 + 18.0;
        final content = bMatch.group(2)!;
        widgets.add(
          Padding(
            padding: EdgeInsets.fromLTRB(indent, 2, 0, 7),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Padding(
                  padding: const EdgeInsets.only(top: 9, right: 10),
                  child: Container(
                    width: 6,
                    height: 6,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: depth > 0 ? Colors.transparent : baseColor.withOpacity(0.85),
                      border: depth > 0
                          ? Border.all(color: baseColor.withOpacity(0.75), width: 1.2)
                          : null,
                    ),
                  ),
                ),
                Expanded(child: _buildRichText(context, content, baseStyle)),
              ],
            ),
          ),
        );
        continue;
      }

      final qMatch = _quoteRe.firstMatch(line);
      if (qMatch != null) {
        flushParagraph();
        widgets.add(
          Container(
            margin: const EdgeInsets.only(bottom: 10),
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
        );
        continue;
      }

      paraBuf.add(line);
    }
    flushParagraph();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: widgets,
    );
  }

  Widget _buildRichText(BuildContext context, String source, TextStyle baseStyle) {
    final span = TextSpan(style: baseStyle, children: _parseInlineSpans(context, source, baseStyle));
    if (selectable) {
      return SelectableText.rich(span);
    }
    return Text.rich(span);
  }

  List<InlineSpan> _parseInlineSpans(BuildContext context, String source, TextStyle baseStyle) {
    final cs = Theme.of(context).colorScheme;
    final surfaces = Gm3Surfaces.of(context);
    final tokenRe = RegExp(r'\*\*(.+?)\*\*|`([^`]+?)`|\\\((.+?)\\\)');
    final spans = <InlineSpan>[];
    var pos = 0;

    for (final m in tokenRe.allMatches(source)) {
      if (m.start > pos) {
        spans.add(TextSpan(text: source.substring(pos, m.start)));
      }
      if (m.group(1) != null) {
        spans.add(TextSpan(
          text: m.group(1),
          style: const TextStyle(fontWeight: FontWeight.w700),
        ));
      } else if (m.group(2) != null) {
        spans.add(TextSpan(
          text: ' ${m.group(2)} ',
          style: GoogleMaterialTheme.monoTextStyle(
            fontSize: (baseStyle.fontSize ?? 15) - 1.5,
            color: cs.primary,
          ).copyWith(backgroundColor: surfaces.card),
        ));
      } else if (m.group(3) != null) {
        spans.add(TextSpan(
          text: m.group(3),
          style: GoogleMaterialTheme.monoTextStyle(
            fontSize: (baseStyle.fontSize ?? 15) - 1,
            color: cs.primary,
          ),
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

class MarkdownCodeBlock extends StatelessWidget {
  final String code;
  final String? lang;
  final bool selectable;
  final bool showCopyButton;

  const MarkdownCodeBlock({
    super.key,
    required this.code,
    this.lang,
    this.selectable = true,
    this.showCopyButton = true,
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
      padding: const EdgeInsets.only(bottom: 12),
      child: Gm3Surface.rounded(
        radius: Gm3.radiusMd,
        clip: true,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
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
            Padding(
              padding: const EdgeInsets.all(12),
              child: selectable
                  ? SelectableText(code, style: mono)
                  : Text(code, style: mono),
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
  const _MathBlock({required this.latex, required this.selectable});

  @override
  Widget build(BuildContext context) {
    final cs = Theme.of(context).colorScheme;
    final style = GoogleMaterialTheme.monoTextStyle(
      fontSize: Gm3.monoMd,
      color: cs.primary,
    );
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
      decoration: BoxDecoration(
        color: Gm3Surfaces.of(context).card,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
      ),
      child: selectable ? SelectableText(latex, style: style) : Text(latex, style: style),
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
