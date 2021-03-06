import java.util.LinkedList;

import org.apache.commons.io.FileUtils;

import java.io.File;
import java.io.IOException;

/**
 * This class implements the first stage in the Viola pipeline, the import of submission files from the conductor.
 */
public class ImportFromConductorRunnable implements Runnable {

    private final LinkedList<LocalTestRunner> toImport;
    private final LinkedList<LocalTestRunner> toNotify;
    private final FairViolaTaskExecutor executor;

    private final static int nretries = 10;
    private final static int backoff = 2;
    private final static int initialPause = 1000;

    public ImportFromConductorRunnable(LinkedList<LocalTestRunner> toImport, LinkedList<LocalTestRunner> toNotify,
            FairViolaTaskExecutor executor) {
        this.toImport = toImport;
        this.executor = executor;
        this.toNotify = toNotify;
    }

    @Override
    public void run() {
        while (true) {
            LocalTestRunner curr = null;
            synchronized(toImport) {
                while (toImport.isEmpty()) {
                    try {
                        toImport.wait();
                    } catch (InterruptedException ie) { }
                }
                curr = toImport.pollLast();

                ViolaUtil.log("received import job for run %d, %d import jobs pending\n", curr.getRunId(),
                        toImport.size());
            }

            final int runId = curr.getRunId();

            final String lbl = String.format("run=%d", curr.getRunId());

            /*
             * Set up directories for storing the student-provided submission files and instructor-provided testing
             * files.
             */
            File assignmentDir = null;
            File submissionDir = null;
            try {
                assignmentDir = CommonUtils.getTempDirectoryName();
                submissionDir = CommonUtils.getTempDirectoryName();
            } catch (IOException io) {
                curr.setErrMsg("Failed reserving directories for Viola import");
            }

            if (assignmentDir != null && submissionDir != null) {
                curr.setCreatedAssignmentDir(assignmentDir);
                curr.setCreatedSubmissionDir(submissionDir);

                final String copyCmd, srcAssignmentPath, srcSubmissionPath;
                if (curr.getEnv().conductorHost.equals("localhost")) {
                    final File srcAssignmentFolder = new File(curr.getAssignmentPath());
                    final File dstAssignmentFolder = new File(assignmentDir.getAbsolutePath());
                    final File srcSubmissionFolder = new File(curr.getSubmissionPath());
                    final File dstSubmissionFolder = new File(submissionDir.getAbsolutePath());

                    try {
                        ViolaUtil.log("ImportFromConductorRunnable: run_id=%s " +
                                "copying %s to %s\n", runId,
                                srcAssignmentFolder.getAbsolutePath(),
                                dstAssignmentFolder.getAbsolutePath());
                        FileUtils.copyDirectory(srcAssignmentFolder, dstAssignmentFolder);
                        ViolaUtil.log("ImportFromConductorRunnable: run_id=%s " +
                                "copying %s to %s\n", runId,
                                srcSubmissionFolder.getAbsolutePath(),
                                dstSubmissionFolder.getAbsolutePath());
                        FileUtils.copyDirectory(srcSubmissionFolder, dstSubmissionFolder);
                        ViolaUtil.log("ImportFromConductorRunnable: run_id=%s " +
                                "done importing files\n", runId);
                    } catch (IOException io) {
                        curr.setErrMsg(io.getMessage());
                    }
                } else {
                    copyCmd = "scp";
                    srcAssignmentPath = curr.getEnv().conductorUser + "@" +
                        curr.getEnv().conductorHost + ":" + curr.getAssignmentPath();
                    srcSubmissionPath = curr.getEnv().conductorUser + "@" +
                        curr.getEnv().conductorHost + ":" + curr.getSubmissionPath();

                    final String[] assignmentScpCmd = new String[] {
                        copyCmd, "-r", srcAssignmentPath,
                        assignmentDir.getAbsolutePath() };
                    final String[] submissionScpCmd = new String[] {
                        copyCmd, "-r", srcSubmissionPath,
                        submissionDir.getAbsolutePath() };

                    final CommonUtils.ProcessResults[] scpResults = new CommonUtils.ProcessResults[1];

                    // SCP the assignment files from the conductor
                    final Throwable assignmentThrowable = CommonUtils.retryUntilSuccess(() -> {
                            try {
                                scpResults[0] = CommonUtils.runInProcess(lbl, assignmentScpCmd, new File("/tmp/"), 30000,
                                    null);
                            } catch (InterruptedException|IOException io) {
                                ViolaUtil.log("ImportFromConductorRunnable: run_id=%s failed scp-ing assignment " +
                                    "directory\n", runId);
                                io.printStackTrace();
                                throw new RuntimeException(io);
                            }
                        }, nretries, initialPause, backoff, "copying assignment files to viola");
                    if (assignmentThrowable != null) {
                        curr.setErrMsg("Unable to transfer assignment files: " + assignmentThrowable.getMessage());
                    } else if (scpResults[0].code != 0) {
                        curr.setErrMsg(scpResults[0].stderr);
                    } else {
                        // SCP the submission files from the conductor
                        final Throwable submissionThrowable = CommonUtils.retryUntilSuccess(() -> {
                                try {
                                    CommonUtils.runInProcess(lbl, submissionScpCmd, new File("/tmp/"), 60000, null);
                                } catch (InterruptedException|IOException io) {
                                    ViolaUtil.log("ImportFromConductorRunnable: run_id=%s failed scp-ing submission " +
                                        "directory\n", runId);
                                    io.printStackTrace();
                                    throw new RuntimeException(io);
                                }
                            }, nretries, initialPause, backoff, "copying submission files to viola");
                        if (submissionThrowable != null) {
                            curr.setErrMsg("Unable to transfer submission files: " + submissionThrowable.getMessage());
                        } else if (scpResults[0].code != 0) {
                            curr.setErrMsg(scpResults[0].stderr);
                        }
                    }
                }
            }

            // When finished, notify the next stage of the pipeline that we have local copies of all files on the Viola.
            if (curr.getErrMsg() != null) {
                synchronized(toNotify) {
                    toNotify.add(curr);
                    toNotify.notify();
                }
            } else {
                executor.execute(curr);
            }
        }
    }
}
