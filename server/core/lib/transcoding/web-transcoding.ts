import { Job } from 'bullmq'
import { move, remove } from 'fs-extra/esm'
import { copyFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { VideoStorage } from '@peertube/peertube-models'
import { computeOutputFPS } from '@server/helpers/ffmpeg/index.js'
import { createTorrentAndSetInfoHash } from '@server/helpers/webtorrent.js'
import { VideoModel } from '@server/models/video/video.js'
import { MVideoFile, MVideoFullLight } from '@server/types/models/index.js'
import { ffprobePromise, getVideoStreamDuration, getVideoStreamFPS, TranscodeVODOptionsType } from '@peertube/peertube-ffmpeg'
import { CONFIG } from '../../initializers/config.js'
import { VideoFileModel } from '../../models/video/video-file.js'
import { JobQueue } from '../job-queue/index.js'
import { generateWebVideoFilename } from '../paths.js'
import { buildFileMetadata } from '../video-file.js'
import { VideoPathManager } from '../video-path-manager.js'
import { buildFFmpegVOD } from './shared/index.js'
import { buildOriginalFileResolution } from './transcoding-resolutions.js'
import { buildStoryboardJobIfNeeded } from '../video.js'

// Optimize the original video file and replace it. The resolution is not changed.
export async function optimizeOriginalVideofile (options: {
  video: MVideoFullLight
  inputVideoFile: MVideoFile
  quickTranscode: boolean
  job: Job
}) {
  const { video, inputVideoFile, quickTranscode, job } = options

  const transcodeDirectory = CONFIG.STORAGE.TMP_DIR
  const newExtname = '.mp4'

  // Will be released by our transcodeVOD function once ffmpeg is ran
  const inputFileMutexReleaser = await VideoPathManager.Instance.lockFiles(video.uuid)

  try {
    await video.reload()
    await inputVideoFile.reload()

    const fileWithVideoOrPlaylist = inputVideoFile.withVideoOrPlaylist(video)

    const result = await VideoPathManager.Instance.makeAvailableVideoFile(fileWithVideoOrPlaylist, async videoInputPath => {
      const videoOutputPath = join(transcodeDirectory, video.id + '-transcoded' + newExtname)

      const transcodeType: TranscodeVODOptionsType = quickTranscode
        ? 'quick-transcode'
        : 'video'

      const resolution = buildOriginalFileResolution(inputVideoFile.resolution)
      const fps = computeOutputFPS({ inputFPS: inputVideoFile.fps, resolution })

      // Could be very long!
      await buildFFmpegVOD(job).transcode({
        type: transcodeType,

        inputPath: videoInputPath,
        outputPath: videoOutputPath,

        inputFileMutexReleaser,

        resolution,
        fps
      })

      // Important to do this before getVideoFilename() to take in account the new filename
      inputVideoFile.resolution = resolution
      inputVideoFile.extname = newExtname
      inputVideoFile.filename = generateWebVideoFilename(resolution, newExtname)
      inputVideoFile.storage = VideoStorage.FILE_SYSTEM

      const { videoFile } = await onWebVideoFileTranscoding({
        video,
        videoFile: inputVideoFile,
        videoOutputPath
      })

      await remove(videoInputPath)

      return { transcodeType, videoFile }
    })

    return result
  } finally {
    inputFileMutexReleaser()
  }
}

// Transcode the original video file to a lower resolution compatible with web browsers
export async function transcodeNewWebVideoResolution (options: {
  video: MVideoFullLight
  resolution: number
  fps: number
  job: Job
}) {
  const { video: videoArg, resolution, fps, job } = options

  const transcodeDirectory = CONFIG.STORAGE.TMP_DIR
  const newExtname = '.mp4'

  const inputFileMutexReleaser = await VideoPathManager.Instance.lockFiles(videoArg.uuid)

  try {
    const video = await VideoModel.loadFull(videoArg.uuid)
    const file = video.getMaxQualityFile().withVideoOrPlaylist(video)

    const result = await VideoPathManager.Instance.makeAvailableVideoFile(file, async videoInputPath => {
      const newVideoFile = new VideoFileModel({
        resolution,
        extname: newExtname,
        filename: generateWebVideoFilename(resolution, newExtname),
        size: 0,
        videoId: video.id
      })

      const videoOutputPath = join(transcodeDirectory, newVideoFile.filename)

      const transcodeOptions = {
        type: 'video' as 'video',

        inputPath: videoInputPath,
        outputPath: videoOutputPath,

        inputFileMutexReleaser,

        resolution,
        fps
      }

      await buildFFmpegVOD(job).transcode(transcodeOptions)

      return onWebVideoFileTranscoding({ video, videoFile: newVideoFile, videoOutputPath })
    })

    return result
  } finally {
    inputFileMutexReleaser()
  }
}

// Merge an image with an audio file to create a video
export async function mergeAudioVideofile (options: {
  video: MVideoFullLight
  resolution: number
  fps: number
  job: Job
}) {
  const { video: videoArg, resolution, fps, job } = options

  const transcodeDirectory = CONFIG.STORAGE.TMP_DIR
  const newExtname = '.mp4'

  const inputFileMutexReleaser = await VideoPathManager.Instance.lockFiles(videoArg.uuid)

  try {
    const video = await VideoModel.loadFull(videoArg.uuid)
    const inputVideoFile = video.getMinQualityFile()

    const fileWithVideoOrPlaylist = inputVideoFile.withVideoOrPlaylist(video)

    const result = await VideoPathManager.Instance.makeAvailableVideoFile(fileWithVideoOrPlaylist, async audioInputPath => {
      const videoOutputPath = join(transcodeDirectory, video.id + '-transcoded' + newExtname)

      // If the user updates the video preview during transcoding
      const previewPath = video.getPreview().getPath()
      const tmpPreviewPath = join(CONFIG.STORAGE.TMP_DIR, basename(previewPath))
      await copyFile(previewPath, tmpPreviewPath)

      const transcodeOptions = {
        type: 'merge-audio' as 'merge-audio',

        inputPath: tmpPreviewPath,
        outputPath: videoOutputPath,

        inputFileMutexReleaser,

        audioPath: audioInputPath,
        resolution,
        fps
      }

      try {
        await buildFFmpegVOD(job).transcode(transcodeOptions)

        await remove(audioInputPath)
        await remove(tmpPreviewPath)
      } catch (err) {
        await remove(tmpPreviewPath)
        throw err
      }

      // Important to do this before getVideoFilename() to take in account the new file extension
      inputVideoFile.extname = newExtname
      inputVideoFile.resolution = resolution
      inputVideoFile.filename = generateWebVideoFilename(inputVideoFile.resolution, newExtname)

      // ffmpeg generated a new video file, so update the video duration
      // See https://trac.ffmpeg.org/ticket/5456
      video.duration = await getVideoStreamDuration(videoOutputPath)
      await video.save()

      return onWebVideoFileTranscoding({
        video,
        videoFile: inputVideoFile,
        videoOutputPath,
        wasAudioFile: true
      })
    })

    return result
  } finally {
    inputFileMutexReleaser()
  }
}

export async function onWebVideoFileTranscoding (options: {
  video: MVideoFullLight
  videoFile: MVideoFile
  videoOutputPath: string
  wasAudioFile?: boolean // default false
}) {
  const { video, videoFile, videoOutputPath, wasAudioFile } = options

  const mutexReleaser = await VideoPathManager.Instance.lockFiles(video.uuid)

  try {
    await video.reload()

    const outputPath = VideoPathManager.Instance.getFSVideoFileOutputPath(video, videoFile)

    const stats = await stat(videoOutputPath)

    const probe = await ffprobePromise(videoOutputPath)
    const fps = await getVideoStreamFPS(videoOutputPath, probe)
    const metadata = await buildFileMetadata(videoOutputPath, probe)

    await move(videoOutputPath, outputPath, { overwrite: true })

    videoFile.size = stats.size
    videoFile.fps = fps
    videoFile.metadata = metadata

    await createTorrentAndSetInfoHash(video, videoFile)

    const oldFile = await VideoFileModel.loadWebVideoFile({ videoId: video.id, fps: videoFile.fps, resolution: videoFile.resolution })
    if (oldFile) await video.removeWebVideoFile(oldFile)

    await VideoFileModel.customUpsert(videoFile, 'video', undefined)
    video.VideoFiles = await video.$get('VideoFiles')

    if (wasAudioFile) {
      await JobQueue.Instance.createJob(buildStoryboardJobIfNeeded({ video, federate: false }))
    }

    return { video, videoFile }
  } finally {
    mutexReleaser()
  }
}
