// The files on their way up: each one's name, state, bytes sent and the controls that fit its state.
import { Button, Icon } from "@vanr/ui";
import { Pause, Play, RotateCw, X } from "lucide-react";
import { useErrorMessage } from "../../../app/screens.tsx";
import { useLocale, useMessages } from "../../../i18n/react.tsx";
import { formatBytes } from "../shared.tsx";
import { isLive, type UploadItem, type useUploadQueue } from "./upload-queue.ts";

type Queue = ReturnType<typeof useUploadQueue>;

export function UploadTray({ queue }: { queue: Queue }) {
  const t = useMessages("files");
  if (queue.items.length === 0) return null;
  const busy = queue.items.some((item) => item.state === "sending" || item.state === "queued");
  return (
    <section className="files__tray" aria-labelledby="files-tray-title">
      <div className="files__tray-head">
        <h2 className="files__tray-title" id="files-tray-title">
          {t("upload.title")}
        </h2>
        {!busy && (
          <Button size="sm" variant="ghost" onClick={() => queue.clearFinished()}>
            {t("upload.clear")}
          </Button>
        )}
      </div>
      <ul className="files__uploads" aria-label={t("upload.title")}>
        {queue.items.map((item) => (
          <Row key={item.id} item={item} queue={queue} />
        ))}
      </ul>
    </section>
  );
}

function Row({ item, queue }: { item: UploadItem; queue: Queue }) {
  const t = useMessages("files");
  const { locale } = useLocale();
  const describe = useErrorMessage("files");
  const name = item.file.name;
  return (
    <li className="files__upload" data-state={item.state}>
      <span className="files__upload-name">{name}</span>
      <span className="files__upload-state" role="status">
        {t(`upload.state.${item.state}`)}
      </span>
      {isLive(item) && (
        <>
          <progress
            className="files__progress"
            max={item.file.size || 1}
            value={item.sent}
            aria-label={t("upload.progressOf", { name })}
          />
          <span className="files__meta">
            {t("upload.progress", {
              sent: formatBytes(item.sent, locale),
              total: formatBytes(item.file.size, locale),
            })}
          </span>
        </>
      )}
      {item.state === "failed" && item.error !== undefined && (
        <span className="files__upload-error">{describe(item.error)}</span>
      )}
      {item.state === "tooBig" && <span className="files__upload-error">{t("upload.tooBigWhy")}</span>}
      <span className="files__upload-controls">
        {item.state === "sending" && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon icon={Pause} />}
            aria-label={t("upload.pause", { name })}
            onClick={() => queue.pause(item.id)}
          />
        )}
        {item.state === "paused" && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon icon={Play} />}
            aria-label={t("upload.resume", { name })}
            onClick={() => queue.resume(item.id)}
          />
        )}
        {item.state === "failed" && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon icon={RotateCw} />}
            aria-label={t("upload.retry", { name })}
            onClick={() => queue.resume(item.id)}
          />
        )}
        {isLive(item) && (
          <Button
            size="sm"
            variant="ghost"
            icon={<Icon icon={X} />}
            aria-label={t("upload.cancel", { name })}
            onClick={() => queue.cancel(item.id)}
          />
        )}
      </span>
    </li>
  );
}
