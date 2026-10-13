package com.edgeoffice.app;

import android.app.Activity;
import android.content.Intent;
import android.database.Cursor;
import android.net.Uri;
import android.os.StatFs;
import android.provider.OpenableColumns;
import androidx.activity.result.ActivityResult;
import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.ActivityCallback;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

@CapacitorPlugin(name = "OfflineRuntime")
public class OfflineRuntimePlugin extends Plugin {
    private static final String REPOSITORY = "liangyanlun/edge-office";
    private static final String SOURCE_GITHUB = "github";
    private static final String SOURCE_MODELSCOPE = "modelscope";
    private static final String MODELSCOPE_0P8_REPOSITORY = BuildConfig.MODELSCOPE_0P8_REPOSITORY;
    private static final String MODELSCOPE_4B_REPOSITORY = BuildConfig.MODELSCOPE_4B_REPOSITORY;
    private static final long GIB = 1024L * 1024L * 1024L;
    private static final long MIN_FREE_SPACE = 160L * 1024L * 1024L;
    private static final Pattern CHECKSUM_LINE = Pattern.compile("^([0-9a-fA-F]{64})\\s+\\*?(.+?)\\s*$");
    private static final String PREFS = "edge-office-offline-runtime";
    private static final String ACTIVE_MODEL_KEY = "activeModelId";
    private static final String FOUR_B_FILE = "Qwen3.5-4B-PPT.Q4_K_M.gguf";
    private static final String FOUR_B_HASH = "31af22f3791eefaef07c431378b9e417d45895458b36e81063289892bb037f38";
    private static final long[] FOUR_B_PART_SIZES = {1_800_000_000L, 908_804_288L};
    private static final String[] FOUR_B_PART_HASHES = {
        "103363136f7c6dd3024cabf7db6cf1e1fdf28a6d4ddb199c5336ec3b31e409d2",
        "5259c12d930c00ddef8808f34360b3aa38915c0145756c357e76e9ea699fd463"
    };
    private static final List<ModelProfile> PROFILES = createProfiles();
    private static final boolean NATIVE_LOADED;

    private final ExecutorService inferenceExecutor = Executors.newSingleThreadExecutor();
    private final ExecutorService downloadExecutor = Executors.newSingleThreadExecutor();
    private final Map<String, DownloadState> downloads = new HashMap<>();
    private final Object downloadLock = new Object();

    static {
        boolean loaded = false;
        try {
            System.loadLibrary("offline-runtime");
            loaded = true;
        } catch (Throwable ignored) {
            // The UI remains usable with local retrieval if native loading is unavailable.
        }
        NATIVE_LOADED = loaded;
    }

    private static List<ModelProfile> createProfiles() {
        List<ModelProfile> profiles = new ArrayList<>();
        profiles.add(new ModelProfile(
            "qwen3.5-0.8b-office", "Qwen3.5 Office 0.8B", 0.8, "Q8_0", "v0.1.0",
            "Qwen3.5-0.8B-office.Q8_0.gguf", 3L * GIB, false,
            "d64517eb198e0c0ebc1f717b9de02f52b476fa3bede99e7af2ac4eace1d3abd3"
        ));
        profiles.add(new ModelProfile(
            "qwen3.5-4b-office", "Qwen3.5 4B PPT · 预发布", 4.0, "Q4_K_M", "v0.2.0-4b",
            FOUR_B_FILE, 6L * GIB, true, FOUR_B_HASH
        ));
        return profiles;
    }

    private static final class ModelProfile {
        final String id;
        final String name;
        final double parameters;
        final String quantization;
        final String releaseTag;
        final String fileName;
        final long maxBytes;
        final boolean largerModel;
        final String pinnedHash;

        ModelProfile(String id, String name, double parameters, String quantization, String releaseTag,
                     String fileName, long maxBytes, boolean largerModel, String pinnedHash) {
            this.id = id;
            this.name = name;
            this.parameters = parameters;
            this.quantization = quantization;
            this.releaseTag = releaseTag;
            this.fileName = fileName;
            this.maxBytes = maxBytes;
            this.largerModel = largerModel;
            this.pinnedHash = pinnedHash;
        }

        String checksumName() {
            return fileName.replaceFirst("\\.gguf$", ".SHA256SUMS.txt");
        }

        String directoryName() {
            return largerModel ? "4B" : "0.8B";
        }
    }

    private static final class DownloadState {
        String state = "idle";
        String phase = "";
        String error = "";
        String verification = "";
        String sourceId = "";
        long downloadedBytes = 0L;
        long totalBytes = 0L;
    }

    private static final class DownloadException extends Exception {
        DownloadException(String message) { super(message); }
    }


    private static native String[] nativeGenerate(String modelPath, String prompt, int maxTokens);

    private File modelDirectory() {
        File directory = new File(getContext().getFilesDir(), "models");
        if (!directory.exists() && !directory.mkdirs()) throw new IllegalStateException("无法创建手机本地模型目录");
        return directory;
    }

    private File profileDirectory(ModelProfile profile) {
        File directory = new File(modelDirectory(), profile.directoryName());
        if (!directory.exists()) directory.mkdirs();
        return directory;
    }

    private File profileModel(ModelProfile profile) {
        return new File(profileDirectory(profile), profile.fileName);
    }

    private ModelProfile profile(String id) {
        if (id == null) return null;
        for (ModelProfile candidate : PROFILES) if (candidate.id.equals(id)) return candidate;
        return null;
    }

    private String activeModelId() {
        return getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE).getString(ACTIVE_MODEL_KEY, "");
    }

    private void saveActiveModelId(String id) {
        getContext().getSharedPreferences(PREFS, Activity.MODE_PRIVATE).edit().putString(ACTIVE_MODEL_KEY, id).apply();
    }

    private File installedModel() {
        String selected = activeModelId();
        if (selected.startsWith("imported:")) {
            File imported = new File(modelDirectory(), selected.substring("imported:".length()));
            if (imported.isFile() && imported.getName().toLowerCase(Locale.ROOT).endsWith(".gguf")) return imported;
        }
        ModelProfile selectedProfile = profile(selected);
        if (selectedProfile != null && profileModel(selectedProfile).isFile()) return profileModel(selectedProfile);
        for (ModelProfile candidate : PROFILES) if (profileModel(candidate).isFile()) return profileModel(candidate);
        File[] legacyModels = modelDirectory().listFiles((dir, name) -> name.toLowerCase(Locale.ROOT).endsWith(".gguf"));
        return legacyModels != null && legacyModels.length > 0 ? legacyModels[0] : null;
    }

    private String modelIdFor(File model) {
        if (model == null) return "";
        for (ModelProfile candidate : PROFILES) if (profileModel(candidate).equals(model)) return candidate.id;
        return "imported:" + model.getName();
    }

    private File generalModel() {
        // The selected model is global. If the user activates 4B, ordinary
        // chat/RAG/Agent and PPT use that same verified file; never silently
        // route the general path back to 0.8B.
        return installedModel();
    }

    private JSObject statusObject() {
        File model = installedModel();
        JSObject result = new JSObject();
        result.put("installed", model != null && model.isFile());
        result.put("name", model == null ? "" : model.getName());
        result.put("size", model == null ? 0 : model.length());
        result.put("activeModelId", modelIdFor(model));
        File chatModel = generalModel();
        result.put("chatModelName", chatModel == null ? "" : chatModel.getName());
        result.put("chatModelInstalled", chatModel != null && chatModel.isFile());
        result.put("modelRoutingNotice", "qwen3.5-4b-office".equals(modelIdFor(model)) ? "已选择 4B：手机普通对话、RAG 与 PPT 计划均使用 4B。PPT 使用离线结构预览，应用后自动保存。" : "");
        result.put("runtime", "Android OfflineRuntime");
        result.put("nativeInference", NATIVE_LOADED && chatModel != null && chatModel.isFile());
        return result;
    }

    @PluginMethod
    public void status(PluginCall call) {
        call.resolve(statusObject());
    }

    @PluginMethod
    public void models(PluginCall call) {
        JSArray items = new JSArray();
        for (ModelProfile model : PROFILES) items.put(modelCatalogItem(model));
        JSObject result = new JSObject();
        result.put("items", items);
        call.resolve(result);
    }

    private JSObject modelCatalogItem(ModelProfile profile) {
        File file = profileModel(profile);
        boolean installed = file.isFile() && file.length() > 0;
        boolean active = installed && file.equals(installedModel());
        File checksum = new File(profileDirectory(profile), profile.checksumName());
        DownloadState state;
        synchronized (downloadLock) {
            state = downloads.get(profile.id);
            if (state == null) state = new DownloadState();
            state = copyState(state);
        }
        JSObject download = new JSObject();
        download.put("state", installed ? "installed" : state.state);
        download.put("phase", state.phase);
        download.put("downloadedBytes", state.downloadedBytes);
        download.put("totalBytes", state.totalBytes);
        if (state.totalBytes > 0) download.put("progressPercent", Math.min(100, state.downloadedBytes * 100.0 / state.totalBytes));
        if (!state.error.isEmpty()) download.put("error", state.error);
        if (!state.verification.isEmpty()) download.put("verification", state.verification);
        if (!state.sourceId.isEmpty()) download.put("sourceId", state.sourceId);

        JSObject item = new JSObject();
        item.put("id", profile.id);
        item.put("name", profile.name);
        item.put("parameterBillions", profile.parameters);
        item.put("quantization", profile.quantization);
        item.put("releaseTag", profile.releaseTag);
        item.put("releaseUrl", "https://github.com/" + REPOSITORY + "/releases/tag/" + profile.releaseTag);
        JSArray sources = new JSArray();
        JSObject github = new JSObject();
        github.put("id", SOURCE_GITHUB);
        github.put("label", "GitHub Releases");
        github.put("available", true);
        sources.put(github);
        JSObject mirror = new JSObject();
        mirror.put("id", SOURCE_MODELSCOPE);
        mirror.put("label", "国内镜像 · 魔搭 ModelScope");
        mirror.put("repository", mirrorRepository(profile));
        boolean mirrorReady = mirrorReady(profile);
        mirror.put("available", mirrorReady);
        mirror.put("reason", mirrorReady ? "" : "镜像仓库与对应模型文件尚未完成哈希核验");
        sources.put(mirror);
        item.put("sources", sources);
        item.put("defaultSourceId", mirrorReady(profile) ? SOURCE_MODELSCOPE : SOURCE_GITHUB);
        item.put("modelDirectory", "应用内部存储 · models/" + profile.directoryName());
        item.put("installed", installed);
        item.put("verified", installed && checksum.isFile());
        item.put("active", active);
        item.put("downloadAvailable", true);
        item.put("downloadEnabled", true);
        item.put("downloadState", installed ? "installed" : state.state);
        item.put("download", download);
        item.put("status", profile.largerModel ? (installed ? "preview-installed" : "preview") : (installed ? "installed" : "available"));
        item.put("capabilities", profile.largerModel ? new JSArray().put("chat").put("rag").put("agent").put("ppt_planner_experimental") : new JSArray().put("chat").put("rag").put("agent"));
        String message;
        if (installed) {
            message = active ? "已安装并正在使用。模型权重保存在手机本机。" : "已完成 SHA-256 校验；点击下方按钮可切换为当前模型。";
        } else if (profile.largerModel) {
            message = "4B PPT-SFT 预发布版：逐片与合并 SHA-256 校验，建议至少 8 GB 内存。手机编辑仅支持五类受限操作和结构预览。";
        } else {
            message = "轻量版本，适合先在手机本地运行；下载后会自动进行 SHA-256 校验。";
        }
        if (!state.error.isEmpty()) message = state.error;
        if (profile.largerModel && state.error.isEmpty()) message = "选择 4B 后，手机普通对话、RAG 与 PPT 计划均使用 4B。建议至少 8 GB 内存；PPT 使用结构预览，复杂版式请导出核对。";
        item.put("message", message);
        return item;
    }

    private DownloadState copyState(DownloadState source) {
        DownloadState result = new DownloadState();
        result.state = source.state;
        result.phase = source.phase;
        result.error = source.error;
        result.verification = source.verification;
        result.sourceId = source.sourceId;
        result.downloadedBytes = source.downloadedBytes;
        result.totalBytes = source.totalBytes;
        return result;
    }

    private void updateDownload(String id, String stateName, String phase, String error, String verification,
                                long downloadedBytes, long totalBytes) {
        synchronized (downloadLock) {
            DownloadState state = downloads.get(id);
            if (state == null) {
                state = new DownloadState();
                downloads.put(id, state);
            }
            if (stateName != null) state.state = stateName;
            if (phase != null) state.phase = phase;
            if (error != null) state.error = error;
            if (verification != null) state.verification = verification;
            state.downloadedBytes = downloadedBytes;
            state.totalBytes = totalBytes;
        }
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        String id = call.getString("modelId", "");
        ModelProfile target = profile(id);
        if (target == null) {
            call.reject("不支持的模型。手机端仅允许下载固定 Release 中的 0.8B 或 4B 模型");
            return;
        }
        String sourceId = call.getString("sourceId", mirrorReady(target) ? SOURCE_MODELSCOPE : SOURCE_GITHUB);
        if (!SOURCE_GITHUB.equals(sourceId) && !SOURCE_MODELSCOPE.equals(sourceId)) {
            call.reject("不支持的模型下载源");
            return;
        }
        if (SOURCE_MODELSCOPE.equals(sourceId) && !mirrorReady(target)) {
            call.reject("国内镜像尚未完成仓库和模型文件的哈希核验");
            return;
        }
        synchronized (downloadLock) {
            for (Map.Entry<String, DownloadState> entry : downloads.entrySet()) {
                if ("downloading".equals(entry.getValue().state)) {
                    call.reject("已有模型下载正在进行，请完成后再下载另一个模型");
                    return;
                }
            }
            DownloadState current = downloads.get(id);
            if (profileModel(target).isFile()) {
                JSObject result = new JSObject();
                result.put("item", modelCatalogItem(target));
                call.resolve(result);
                return;
            }
            updateDownload(id, "downloading", SOURCE_MODELSCOPE.equals(sourceId) ? "正在连接国内镜像" : "正在连接固定 GitHub Release", "", "", 0L, 0L);
            downloads.get(id).sourceId = sourceId;
        }
        JSObject result = new JSObject();
        result.put("item", modelCatalogItem(target));
        call.resolve(result);
        downloadExecutor.execute(() -> runModelDownload(target, sourceId));
    }

    private void runModelDownload(ModelProfile profile, String sourceId) {
        if (profile.largerModel) {
            runFourBDownload(profile, sourceId);
            return;
        }
        File directory = profileDirectory(profile);
        File modelPart = new File(directory, profile.fileName + (SOURCE_MODELSCOPE.equals(sourceId) ? ".modelscope.part" : ".part"));
        File checksumPart = new File(directory, profile.checksumName() + ".part");
        try {
            if (profile.pinnedHash.isEmpty()) throw new DownloadException("模型缺少应用内固定 SHA-256，已阻止安装");
            // Both approved sources must match the same hash embedded in the APK.
            // The original 0.8B Release checksum asset may be empty, so never
            // trust it as the authority for a fixed model.
            String checksumText = profile.pinnedHash + "  " + profile.fileName + "\n";
            String expectedHash = parseChecksum(checksumText, profile.fileName);
            if (!profile.pinnedHash.isEmpty() && !profile.pinnedHash.equalsIgnoreCase(expectedHash)) {
                throw new DownloadException("校验文件与应用内固定 SHA-256 不一致，已阻止下载");
            }
            updateDownload(profile.id, "downloading", "正在下载模型", "", "", modelPart.isFile() ? modelPart.length() : 0L, 0L);
            String actualHash = downloadModelFile(profile, sourceId, modelPart);
            updateDownload(profile.id, "downloading", "正在校验模型", "", "", modelPart.length(), modelPart.length());
            if (!actualHash.equalsIgnoreCase(expectedHash)) {
                modelPart.delete();
                throw new DownloadException("模型 SHA-256 校验失败，文件未安装到手机");
            }
            File destination = profileModel(profile);
            File checksumDestination = new File(directory, profile.checksumName());
            if (destination.exists()) throw new DownloadException("该模型已安装，请在模型中心切换使用");
            try (FileOutputStream output = new FileOutputStream(checksumPart, false)) {
                output.write(checksumText.getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            if (checksumDestination.exists() && !checksumDestination.delete()) throw new DownloadException("无法更新 SHA-256 校验记录");
            if (!checksumPart.renameTo(checksumDestination)) throw new DownloadException("无法保存 SHA-256 校验记录");
            if (!modelPart.renameTo(destination)) {
                checksumDestination.delete();
                throw new DownloadException("校验通过，但模型无法安装；请检查手机剩余空间");
            }
            if (installedModel() == null) saveActiveModelId(profile.id);
            updateDownload(profile.id, "completed", "下载并校验完成", "", "sha256", destination.length(), destination.length());
        } catch (DownloadException error) {
            updateDownload(profile.id, "failed", "下载未完成", error.getMessage(), "", modelPart.isFile() ? modelPart.length() : 0L, 0L);
        } catch (Exception error) {
            updateDownload(profile.id, "failed", "下载未完成", "下载失败，请检查网络或手机存储空间后重试", "", modelPart.isFile() ? modelPart.length() : 0L, 0L);
        } finally {
            checksumPart.delete();
        }
    }

    private void runFourBDownload(ModelProfile profile, String sourceId) {
        File directory = profileDirectory(profile);
        File[] parts = {
            new File(directory, profile.fileName + ".part-00." + sourceId + ".download"),
            new File(directory, profile.fileName + ".part-01." + sourceId + ".download")
        };
        File assembled = new File(directory, profile.fileName + ".assembling");
        File checksumPart = new File(directory, profile.checksumName() + ".part");
        long total = FOUR_B_PART_SIZES[0] + FOUR_B_PART_SIZES[1];
        try {
            if (SOURCE_MODELSCOPE.equals(sourceId) && !mirrorReady(profile)) throw new DownloadException("4B 国内镜像尚未完成核验");
            if (!FOUR_B_HASH.equalsIgnoreCase(profile.pinnedHash)) throw new DownloadException("4B 内置校验配置无效");
            long remaining = total;
            for (int i = 0; i < parts.length; i++) remaining -= Math.min(parts[i].isFile() ? parts[i].length() : 0L, FOUR_B_PART_SIZES[i]);
            long free = new StatFs(directory.getAbsolutePath()).getAvailableBytes();
            if (free < remaining + total + MIN_FREE_SPACE) throw new DownloadException("手机空间不足：分片合并期间约需 5.5 GB 可用空间，请清理后重试");
            long completed = 0L;
            for (int i = 0; i < parts.length; i++) {
                String asset = profile.fileName + String.format(Locale.ROOT, ".part-%02d", i);
                updateDownload(profile.id, "downloading", "正在下载第 " + (i + 1) + "/2 片", "", "", completed, total);
                String digest;
                if (parts[i].isFile() && parts[i].length() == FOUR_B_PART_SIZES[i]) {
                    MessageDigest cached = MessageDigest.getInstance("SHA-256");
                    updateDigestFromFile(cached, parts[i]);
                    digest = toHex(cached.digest());
                    if (!digest.equalsIgnoreCase(FOUR_B_PART_HASHES[i])) parts[i].delete();
                } else {
                    digest = "";
                }
                if (!digest.equalsIgnoreCase(FOUR_B_PART_HASHES[i])) {
                    digest = downloadModelFile(profile, sourceId, parts[i], asset, FOUR_B_PART_SIZES[i], completed, total);
                }
                if (!digest.equalsIgnoreCase(FOUR_B_PART_HASHES[i])) {
                    parts[i].delete();
                    throw new DownloadException("第 " + (i + 1) + " 片 SHA-256 不匹配，已删除损坏分片");
                }
                completed += FOUR_B_PART_SIZES[i];
            }
            updateDownload(profile.id, "downloading", "正在合并并校验完整 GGUF", "", "", total, total);
            MessageDigest whole = MessageDigest.getInstance("SHA-256");
            try (FileOutputStream fileOutput = new FileOutputStream(assembled, false);
                 BufferedOutputStream output = new BufferedOutputStream(fileOutput)) {
                byte[] buffer = new byte[1024 * 1024];
                for (File part : parts) {
                    try (InputStream input = new BufferedInputStream(new FileInputStream(part))) {
                        int read;
                        while ((read = input.read(buffer)) != -1) { output.write(buffer, 0, read); whole.update(buffer, 0, read); }
                    }
                }
                output.flush();
                fileOutput.getFD().sync();
            }
            if (assembled.length() != total || !toHex(whole.digest()).equalsIgnoreCase(FOUR_B_HASH)) {
                assembled.delete();
                throw new DownloadException("完整 GGUF 的大小或 SHA-256 校验失败，未安装模型");
            }
            File destination = profileModel(profile);
            if (destination.exists()) throw new DownloadException("该模型已安装，请在模型中心切换使用");
            File checksum = new File(directory, profile.checksumName());
            try (FileOutputStream output = new FileOutputStream(checksumPart, false)) {
                output.write((FOUR_B_HASH + "  " + profile.fileName + "\n").getBytes(StandardCharsets.UTF_8));
                output.getFD().sync();
            }
            if (!assembled.renameTo(destination)) throw new DownloadException("合并模型无法安装，请检查手机存储空间");
            if (!checksumPart.renameTo(checksum)) { destination.delete(); throw new DownloadException("无法保存模型校验记录"); }
            if (installedModel() == null) saveActiveModelId(profile.id);
            for (File part : parts) part.delete();
            updateDownload(profile.id, "completed", "4B 分片合并与校验完成", "", "pinned-part-and-merged-sha256", total, total);
        } catch (DownloadException error) {
            updateDownload(profile.id, "failed", "下载未完成", error.getMessage(), "", 0L, total);
        } catch (Exception error) {
            updateDownload(profile.id, "failed", "下载未完成", "4B 下载失败；可检查网络或空间后重试", "", 0L, total);
        } finally {
            assembled.delete();
            checksumPart.delete();
        }
    }

    private String assetUrl(ModelProfile profile, String sourceId, String assetName) {
        if (SOURCE_MODELSCOPE.equals(sourceId)) {
            return "https://modelscope.cn/models/" + mirrorRepository(profile) + "/resolve/master/" + assetName;
        }
        return "https://github.com/" + REPOSITORY + "/releases/download/" + profile.releaseTag + "/" + assetName;
    }

    private boolean mirrorReady(ModelProfile profile) {
        return !mirrorRepository(profile).isEmpty() && !profile.pinnedHash.isEmpty() &&
            (profile.largerModel ? BuildConfig.MODELSCOPE_4B_VERIFIED : BuildConfig.MODELSCOPE_0P8_VERIFIED);
    }

    private String mirrorRepository(ModelProfile profile) {
        return profile.largerModel ? MODELSCOPE_4B_REPOSITORY : MODELSCOPE_0P8_REPOSITORY;
    }

    private HttpURLConnection openConnection(String url, long rangeStart) throws Exception {
        HttpURLConnection connection = (HttpURLConnection) new URL(url).openConnection();
        connection.setConnectTimeout(25000);
        connection.setReadTimeout(45000);
        connection.setInstanceFollowRedirects(true);
        connection.setUseCaches(false);
        connection.setRequestProperty("User-Agent", "Edge-Office-Android-Model-Downloader/1.0");
        connection.setRequestProperty("Accept", "application/octet-stream");
        if (rangeStart > 0L) connection.setRequestProperty("Range", "bytes=" + rangeStart + "-");
        return connection;
    }

    private void validateFinalHost(HttpURLConnection connection, String sourceId) throws DownloadException {
        String host = connection.getURL().getHost().toLowerCase(Locale.ROOT);
        boolean allowed = SOURCE_MODELSCOPE.equals(sourceId)
            ? host.equals("modelscope.cn") || host.endsWith(".modelscope.cn") || host.endsWith(".aliyuncs.com")
            : host.equals("github.com") || host.equals("objects.githubusercontent.com") ||
              host.equals("release-assets.githubusercontent.com");
        if (!allowed) {
            throw new DownloadException("模型下载跳转到了不受信任的站点，已阻止");
        }
        if (!"https".equalsIgnoreCase(connection.getURL().getProtocol())) {
            throw new DownloadException("模型下载未使用 HTTPS，已阻止");
        }
    }

    private String downloadSmallText(String url, long maxBytes) throws Exception {
        HttpURLConnection connection = openConnection(url, 0L);
        try {
            int code = connection.getResponseCode();
            validateFinalHost(connection, SOURCE_GITHUB);
            if (code == HttpURLConnection.HTTP_NOT_FOUND) throw new DownloadException("该模型的固定 Release 尚未上传 GGUF 模型或 SHA-256 校验文件，暂时无法下载");
            if (code < 200 || code >= 300) throw new DownloadException("GitHub Release 暂时无法提供模型校验文件（HTTP " + code + "）");
            long announced = connection.getContentLengthLong();
            if (announced > maxBytes) throw new DownloadException("SHA-256 校验文件大小异常，已阻止下载");
            ByteArrayOutputStream output = new ByteArrayOutputStream();
            try (InputStream input = new BufferedInputStream(connection.getInputStream())) {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    if (output.size() + read > maxBytes) throw new DownloadException("SHA-256 校验文件大小异常，已阻止下载");
                    output.write(buffer, 0, read);
                }
            }
            return new String(output.toByteArray(), StandardCharsets.UTF_8);
        } finally {
            connection.disconnect();
        }
    }

    private String parseChecksum(String contents, String modelFileName) throws DownloadException {
        for (String line : contents.split("\\r?\\n")) {
            Matcher match = CHECKSUM_LINE.matcher(line.trim());
            if (match.matches() && new File(match.group(2)).getName().equals(modelFileName)) return match.group(1).toLowerCase(Locale.ROOT);
        }
        throw new DownloadException("SHA-256 校验文件中没有对应的 GGUF 文件名，已取消安装");
    }

    private String downloadModelFile(ModelProfile profile, String sourceId, File part) throws Exception {
        return downloadModelFile(profile, sourceId, part, profile.fileName, -1L, 0L, 0L);
    }

    private String downloadModelFile(ModelProfile profile, String sourceId, File part, String assetName,
                                     long expectedSize, long progressBase, long overallTotal) throws Exception {
        long offset = part.isFile() ? part.length() : 0L;
        if (offset > profile.maxBytes || (expectedSize > 0L && offset > expectedSize)) {
            part.delete();
            offset = 0L;
        }
        HttpURLConnection connection = openConnection(assetUrl(profile, sourceId, assetName), offset);
        int code;
        try {
            code = connection.getResponseCode();
            validateFinalHost(connection, sourceId);
            if (code == HttpURLConnection.HTTP_NOT_FOUND) throw new DownloadException("所选下载源尚未提供 " + profile.fileName);
            if (offset > 0L && code != HttpURLConnection.HTTP_PARTIAL) {
                connection.disconnect();
                part.delete();
                offset = 0L;
                connection = openConnection(assetUrl(profile, sourceId, assetName), 0L);
                code = connection.getResponseCode();
                validateFinalHost(connection, sourceId);
                if (code == HttpURLConnection.HTTP_NOT_FOUND) throw new DownloadException("所选下载源尚未提供 " + profile.fileName);
            }
            if (code < 200 || code >= 300) throw new DownloadException("所选下载源暂时无法提供该模型（HTTP " + code + "）");
            long contentLength = connection.getContentLengthLong();
            long total = offset > 0L && contentLength > 0L ? offset + contentLength : contentLength;
            if (total > profile.maxBytes) throw new DownloadException("模型文件超过手机端为此型号设定的下载上限，已阻止安装");
            if (expectedSize > 0L && total > expectedSize) throw new DownloadException("模型分片超过固定大小，已阻止安装");
            long freeBytes = new StatFs(profileDirectory(profile).getAbsolutePath()).getAvailableBytes();
            if (total > 0L && freeBytes < total - offset + MIN_FREE_SPACE) throw new DownloadException("手机可用空间不足；请至少腾出模型文件大小及额外 160 MB 空间后重试");

            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            if (offset > 0L) updateDigestFromFile(digest, part);
            long downloaded = offset;
            updateDownload(profile.id, "downloading", null, "", "", progressBase + downloaded, overallTotal > 0L ? overallTotal : total);
            try (InputStream input = new BufferedInputStream(connection.getInputStream());
                 FileOutputStream fileOutput = new FileOutputStream(part, offset > 0L);
                 BufferedOutputStream output = new BufferedOutputStream(fileOutput)) {
                byte[] buffer = new byte[1024 * 1024];
                int read;
                while ((read = input.read(buffer)) != -1) {
                    downloaded += read;
                    if (downloaded > profile.maxBytes) throw new DownloadException("模型文件超过手机端为此型号设定的下载上限，已阻止安装");
                    if (expectedSize > 0L && downloaded > expectedSize) throw new DownloadException("模型分片超过固定大小，已阻止安装");
                    output.write(buffer, 0, read);
                    digest.update(buffer, 0, read);
                    updateDownload(profile.id, "downloading", null, "", "", progressBase + downloaded, overallTotal > 0L ? overallTotal : total);
                }
                output.flush();
                fileOutput.getFD().sync();
            }
            if (total > 0L && downloaded != total) throw new DownloadException("模型文件未完整下载；保留已下载部分，可点击重试继续");
            if (expectedSize > 0L && downloaded != expectedSize) throw new DownloadException("模型分片未完整下载；保留已下载部分，可点击重试继续");
            return toHex(digest.digest());
        } finally {
            connection.disconnect();
        }
    }

    private void updateDigestFromFile(MessageDigest digest, File file) throws Exception {
        try (InputStream input = new BufferedInputStream(new FileInputStream(file))) {
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) digest.update(buffer, 0, read);
        }
    }

    private String toHex(byte[] bytes) {
        StringBuilder result = new StringBuilder(bytes.length * 2);
        for (byte value : bytes) result.append(String.format(Locale.ROOT, "%02x", value & 0xff));
        return result.toString();
    }

    @PluginMethod
    public void activateModel(PluginCall call) {
        String id = call.getString("modelId", "");
        ModelProfile target = profile(id);
        if (target == null || !profileModel(target).isFile()) {
            call.reject("该模型尚未完整安装，无法切换");
            return;
        }
        inferenceExecutor.execute(() -> {
            try {
                File file = profileModel(target);
                File checksum = new File(profileDirectory(target), target.checksumName());
                if (!checksum.isFile()) throw new DownloadException("模型校验记录缺失，无法切换");
                String recorded = parseChecksum(new String(java.nio.file.Files.readAllBytes(checksum.toPath()), StandardCharsets.UTF_8), target.fileName);
                if (!recorded.equalsIgnoreCase(target.pinnedHash)) throw new DownloadException("模型校验记录与包内固定值不一致");
                MessageDigest digest = MessageDigest.getInstance("SHA-256");
                updateDigestFromFile(digest, file);
                if (!toHex(digest.digest()).equalsIgnoreCase(target.pinnedHash)) throw new DownloadException("模型文件 SHA-256 不匹配，已阻止切换");
                saveActiveModelId(target.id);
                call.resolve(statusObject());
            } catch (Exception error) {
                call.reject("模型校验失败：" + error.getMessage());
            }
        });
    }

    @PluginMethod
    public void infer(PluginCall call) {
        File model = generalModel();
        if (!NATIVE_LOADED || model == null || !model.isFile()) {
            call.reject("普通问答需要已激活且可用的本机模型，请在模型中心完成模型校验和启用");
            return;
        }
        String prompt = call.getString("prompt", "");
        int maxTokens = Math.max(8, Math.min(1024, call.getInt("maxTokens", 1024)));
        if (prompt == null || prompt.trim().isEmpty()) {
            call.reject("推理提示词不能为空");
            return;
        }
        inferenceExecutor.execute(() -> {
            long started = System.nanoTime();
            try {
                String[] generated = nativeGenerate(model.getAbsolutePath(), prompt, maxTokens);
                String answer = generated == null || generated.length != 4 ? null : generated[0];
                if (answer == null || answer.trim().isEmpty()) {
                    call.reject("本地模型没有返回内容");
                    return;
                }
                long responseLatencyMs = Math.max(1L, (System.nanoTime() - started) / 1_000_000L);
                int generatedTokens = Integer.parseInt(generated[1]);
                long generationMs = Long.parseLong(generated[2]);
                JSObject result = new JSObject();
                result.put("answer", answer.trim());
                result.put("generatedTokens", generatedTokens);
                result.put("finishReason", generated[3]);
                result.put("generationMs", generationMs);
                result.put("responseLatencyMs", responseLatencyMs);
                result.put("tokensPerSecond", generatedTokens > 0 && generationMs > 0 ? generatedTokens * 1000.0 / generationMs : 0);
                result.put("model", model.getName());
                call.resolve(result);
            } catch (Throwable error) {
                call.reject("本地模型推理失败：" + (error.getMessage() == null ? "未知错误" : error.getMessage()));
            }
        });
    }

    @PluginMethod
    public void pickModel(PluginCall call) {
        Intent intent = new Intent(Intent.ACTION_OPEN_DOCUMENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        startActivityForResult(call, intent, "modelPickerResult");
    }

    @ActivityCallback
    private void modelPickerResult(PluginCall call, ActivityResult result) {
        if (result.getResultCode() != Activity.RESULT_OK || result.getData() == null || result.getData().getData() == null) {
            call.reject("已取消模型导入");
            return;
        }
        Uri uri = result.getData().getData();
        String displayName = queryDisplayName(uri);
        if (displayName == null || !displayName.toLowerCase(Locale.ROOT).endsWith(".gguf")) {
            call.reject("请选择 .gguf 模型文件");
            return;
        }
        displayName = displayName.replaceAll("[^A-Za-z0-9._-]", "_");
        File temporary = new File(modelDirectory(), displayName + ".importing");
        File destination = new File(modelDirectory(), displayName);
        if (destination.exists()) destination = new File(modelDirectory(), System.currentTimeMillis() + "-" + displayName);
        try (InputStream input = getContext().getContentResolver().openInputStream(uri);
             FileOutputStream fileOutput = new FileOutputStream(temporary, false);
             BufferedOutputStream output = new BufferedOutputStream(fileOutput)) {
            if (input == null) throw new IllegalStateException("无法读取所选文件");
            byte[] buffer = new byte[1024 * 1024];
            int read;
            while ((read = input.read(buffer)) != -1) output.write(buffer, 0, read);
            output.flush();
            fileOutput.getFD().sync();
            if (!temporary.renameTo(destination)) throw new IllegalStateException("模型无法保存到应用目录");
            saveActiveModelId("imported:" + destination.getName());
            call.resolve(statusObject());
        } catch (Exception error) {
            temporary.delete();
            call.reject("模型导入失败：" + error.getMessage());
        }
    }

    private String queryDisplayName(Uri uri) {
        try (Cursor cursor = getContext().getContentResolver().query(uri, null, null, null, null)) {
            if (cursor != null && cursor.moveToFirst()) {
                int index = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME);
                if (index >= 0) return cursor.getString(index);
            }
        } catch (Exception ignored) {
            // Fall back to the provider's URI when DISPLAY_NAME is unavailable.
        }
        String segment = uri.getLastPathSegment();
        if (segment == null) return null;
        int slash = segment.lastIndexOf('/');
        return slash >= 0 ? segment.substring(slash + 1) : segment;
    }
}
