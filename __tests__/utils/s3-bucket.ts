import {
  DeleteBucketCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
  type S3Client,
} from '@aws-sdk/client-s3';

/**
 * Empties a test bucket, a page of objects at a time, then deletes it (#502). Each bucket
 * left behind is a SeaweedFS collection holding volume slots, and a dev box that ran the
 * suites often enough ran out of them: every S3 test then failed with `InternalError`.
 */
export async function removeBucket(s3: S3Client, bucket: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }),
    );
    const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length > 0)
      await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }));
    token = page.IsTruncated ? page.NextContinuationToken : undefined;
  } while (token);
  await s3.send(new DeleteBucketCommand({ Bucket: bucket }));
}
