import 'dart:io';

import 'package:flutter/material.dart';
import 'package:path/path.dart' as p;

import '../l10n/app_strings.dart';
import '../models.dart';
import '../platform/window_chrome.dart';
import '../theme.dart';

Future<void> openLocalAttachment(BuildContext context, File file) async {
  final opened = await WindowChrome.openLocalFile(file.absolute.path);
  if (!opened && context.mounted) {
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      SnackBar(content: Text(AppStringsScope.of(context).mediaOpenFailed)),
    );
  }
}

String attachmentName(ViewBlock block) {
  final name = block.meta?['name'];
  if (name is String && name.trim().isNotEmpty) return p.basename(name.trim());
  final text = block.text?.trim();
  if (text != null && text.isNotEmpty) {
    return p.basename(text.split(RegExp(r'[\r\n]')).first);
  }
  for (final reference in [
    block.meta?['local_path'],
    block.meta?['path'],
    block.meta?['url'],
    block.meta?['asset_pointer'],
  ]) {
    if (reference is String && reference.isNotEmpty) {
      final uri = Uri.tryParse(reference);
      final segments = uri?.pathSegments;
      if (segments != null && segments.isNotEmpty) {
        return p.basename(segments.last);
      }
      return p.basename(reference);
    }
  }
  final sha = block.blobSha256;
  if (sha != null && sha.length >= 10)
    return '${block.type}_${sha.substring(0, 10)}';
  return block.type;
}

class MediaImage extends StatelessWidget {
  final File? file;
  final String label;
  final double maxHeight;

  const MediaImage({
    super.key,
    required this.file,
    required this.label,
    this.maxHeight = 340,
  });

  Widget _placeholder(BuildContext context, String status) {
    return Container(
      padding: const EdgeInsets.all(10),
      decoration: BoxDecoration(
        color: Gm3Surfaces.of(context).inset,
        borderRadius: BorderRadius.circular(Gm3.radiusMd),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.broken_image_outlined, size: 16),
          const SizedBox(width: 8),
          Flexible(
            child: Text('$status · $label',
                style: Theme.of(context).textTheme.bodySmall),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final strings = AppStringsScope.of(context);
    final image = file;
    if (image == null) return _placeholder(context, strings.mediaFileMissing);
    return ClipRRect(
      borderRadius: BorderRadius.circular(Gm3.radiusMd),
      child: ConstrainedBox(
        constraints: BoxConstraints(maxHeight: maxHeight),
        child: Image.file(
          image,
          fit: BoxFit.contain,
          semanticLabel: label,
          errorBuilder: (context, _, __) =>
              _placeholder(context, strings.mediaFileUnreadable),
        ),
      ),
    );
  }
}

class AttachmentChipGroup extends StatelessWidget {
  final List<ViewBlock> attachmentBlocks;
  final File? Function(ViewBlock block) resolveMediaFile;

  const AttachmentChipGroup({
    super.key,
    required this.attachmentBlocks,
    required this.resolveMediaFile,
  });

  static IconData iconFor(ViewBlock block) => switch (block.type) {
        'audio' => Icons.audio_file_outlined,
        'video' => Icons.video_file_outlined,
        'link' => Icons.link,
        _ => Icons.description_outlined,
      };

  @override
  Widget build(BuildContext context) {
    final primary = attachmentBlocks.first;
    final extraCount = attachmentBlocks.length - 1;
    final label =
        '${attachmentName(primary)}${extraCount > 0 ? ' + $extraCount' : ''}';
    final strings = AppStringsScope.of(context);

    return MenuAnchor(
      menuChildren: [
        for (final block in attachmentBlocks) _entry(context, block, strings),
      ],
      builder: (context, controller, child) => ActionChip(
        avatar: Icon(iconFor(primary), size: 16),
        label: Text(label, maxLines: 1, overflow: TextOverflow.ellipsis),
        onPressed: () =>
            controller.isOpen ? controller.close() : controller.open(),
      ),
    );
  }

  Widget _entry(BuildContext context, ViewBlock block, AppStrings strings) {
    final file = resolveMediaFile(block);
    return MenuItemButton(
      leadingIcon: Icon(iconFor(block), size: 16),
      onPressed: file == null ? null : () => openLocalAttachment(context, file),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 280),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(attachmentName(block),
                maxLines: 2, overflow: TextOverflow.ellipsis),
            Text(file == null
                ? strings.mediaFileMissing
                : strings.openMediaFile),
          ],
        ),
      ),
    );
  }
}
