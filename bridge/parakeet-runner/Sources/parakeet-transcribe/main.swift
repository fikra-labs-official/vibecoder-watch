import FluidAudio
import Foundation

@main
struct ParakeetTranscribe {
    static func emit(_ value: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: value),
              var line = String(data: data, encoding: .utf8) else { return }
        line += "\n"
        FileHandle.standardOutput.write(Data(line.utf8))
    }

    static func main() async {
        guard CommandLine.arguments.count == 2 else {
            emit(["ready": false, "error": "usage: parakeet-transcribe MODEL_DIR"])
            return
        }

        let modelDirectory = URL(
            fileURLWithPath: CommandLine.arguments[1],
            isDirectory: true
        )
        let manager = AsrManager(config: .default)
        let loadStarted = ContinuousClock.now
        do {
            let models = try await AsrModels.load(
                from: modelDirectory,
                version: .v3,
                encoderPrecision: .int8
            )
            try await manager.loadModels(models)
        } catch {
            emit(["ready": false, "error": String(describing: error)])
            return
        }
        emit([
            "ready": true,
            "load_ms": loadStarted.duration(to: .now).milliseconds,
        ])

        while let line = readLine() {
            guard let data = line.data(using: .utf8),
                  let request = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let identifier = request["id"] as? String,
                  let audioPath = request["audio_path"] as? String else {
                emit(["ok": false, "error": "invalid request"])
                continue
            }

            let started = ContinuousClock.now
            do {
                let languageCode = request["language"] as? String
                let language = languageCode.flatMap {
                    $0 == "auto" ? nil : Language(rawValue: $0)
                }
                var decoderState = TdtDecoderState.make(
                    decoderLayers: await manager.decoderLayerCount
                )
                let result = try await manager.transcribe(
                    URL(fileURLWithPath: audioPath),
                    decoderState: &decoderState,
                    language: language
                )
                emit([
                    "id": identifier,
                    "ok": true,
                    "text": result.text,
                    "inference_ms": started.duration(to: .now).milliseconds,
                ])
            } catch {
                emit([
                    "id": identifier,
                    "ok": false,
                    "error": String(describing: error),
                ])
            }
        }
        await manager.cleanup()
    }
}

extension Duration {
    var milliseconds: Double {
        let parts = components
        return Double(parts.seconds) * 1_000 + Double(parts.attoseconds) / 1e15
    }
}
