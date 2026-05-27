/**
 * Media node serializers (image, video, audio)
 * Uses ![alt](src) format for all media types
 */

import type { NodeSerializer, MarkdownSerializerState } from './types';
import type { Node as ProseMirrorNode } from '@tiptap/pm/model';

/**
 * Image serializer - ![alt|width](src)
 */
function serializeImage(state: MarkdownSerializerState, node: ProseMirrorNode): void {
    const src = node.attrs.src || '';
    const alt = node.attrs.alt || '';
    const width = node.attrs.width;

    const altWithWidth = width ? `${alt}|${width}` : alt;
    state.write(`![${altWithWidth}](${src})`);
}

/**
 * Video serializer - ![video|width](src)
 */
function serializeVideo(state: MarkdownSerializerState, node: ProseMirrorNode): void {
    const src = node.attrs.src || '';
    const width = node.attrs.width;

    const alt = width ? `video|${width}` : 'video';
    state.write(`![${alt}](${src})`);
}

/**
 * Audio serializer - ![audio](src)
 */
function serializeAudio(state: MarkdownSerializerState, node: ProseMirrorNode): void {
    const src = node.attrs.src || '';
    state.write(`![audio](${src})`);
}

export const imageSerializer: NodeSerializer = {
    name: 'image',
    serialize: serializeImage,
};

export const videoSerializer: NodeSerializer = {
    name: 'video',
    serialize: serializeVideo,
};

export const audioSerializer: NodeSerializer = {
    name: 'audio',
    serialize: serializeAudio,
};

/**
 * Combined media serializers export
 */
export const mediaSerializers = {
    image: imageSerializer,
    video: videoSerializer,
    audio: audioSerializer,
};
