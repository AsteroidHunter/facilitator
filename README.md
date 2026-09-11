## License

This project is released under the [Facilitator License 1.0.0](LICENSE.md). Contributions are accepted under the terms in [CONTRIBUTING.md](CONTRIBUTING.md).

## Attachments

Card and chat composers accept files from the attach button, drag and drop, or a clipboard that provides files. The document page's existing drop path accepts the same types. Each file can be at most 32 MiB. Unsupported, empty and oversized files show a message. Uploads keep their original bytes and add a local `/uploads/...` address to the message.

| Files | Extensions | Content types |
| --- | --- | --- |
| Images | `.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg` | `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `image/svg+xml` |
| Video | `.mp4`, `.m4v`, `.mov`, `.webm`, `.ogv` | `video/mp4`, `video/x-m4v`, `video/quicktime`, `video/webm`, `video/ogg` |
| Audio | `.mp3`, `.m4a`, `.aac`, `.wav`, `.ogg`, `.oga`, `.opus`, `.weba` | `audio/mpeg`, `audio/mp4`, `audio/aac`, `audio/wav`, `audio/ogg`, `audio/webm` |
| PDF | `.pdf` | `application/pdf` |
| Word | `.doc`, `.docx` | `application/msword`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document` |

A recognized extension is required. A file without an extension can use one of the listed MIME types; the client adds its extension. `audio/x-wav` and `audio/x-m4a` are also recognized for extensionless clipboard files.

Images retain their existing display. Audio and video have controls without autoplay, and every media or document attachment has its filename plus Open and Download links. Playback depends on the browser's codec support, which the file extension alone cannot guarantee. Unsupported codecs can still be downloaded. PDF viewing depends on the browser; Word files download for opening in a compatible app. Files are not converted. Lane panel images remain image-only.

The server must be restarted after installing this change, then clients reloaded. The new file types require the updated upload routes as well as the updated client files.
