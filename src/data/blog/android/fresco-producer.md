---
title: "Fresco图片加载框架（二）--- Producer"
description: "深入分析 Fresco ImagePipeline 中的 Producer 机制，包括 Sequence Producer 链式设计、DiskCacheProducer、MultiplexProducer 请求去重、以及管道式架构的扩展性"
pubDatetime: 2016-01-12T00:00:00Z
modDatetime: 2016-01-12T00:00:00Z
author: "xuwakao"
slug: "fresco-producer"
tags:
  - android
  - fresco
  - source-code
  - image-pipeline
featured: false
---

## Table of contents

## 前言

```java
/**
* 本文可以随意转载到任何网站或者App，
* BUT
* 转载也要按"基本法"，
* 请注明原文出处和作者
*/
```

[官方源码地址](https://github.com/facebook/fresco)

[fresco官方高大上介绍（1）](http://frescolib.org/index.html)（注意：前方有堵墙）

[fresco官方高大上介绍（2）](https://code.facebook.com/posts/366199913563917/introducing-fresco-a-new-image-library-for-android/)（注意：前方有堵墙）

## 介绍

上一篇大概介绍了fresco这个lib的整体结构和流程，这篇主要介绍 **fresco** 中关键的一部分 -- **Producer**。

个人觉得，**Producer** 基本是整个 **ImagePipeline** module的核心，串联了整个图片读取的流程和各个细节（decode，resize等等）的处理，而且感觉整个设计上很有意思，读完感觉收益匪浅。

## 正文

*（分析主要是代码，相当枯燥~~~sigh）*

以一次网络请求的例，进行分析，其他类型的请求，例如从cache中读取图片等，都差不多。

当 **SimpleDraweeView#setController** 后，图片拉取的流程就开始了（详细流程可以参看上一篇的流程图）。忽略掉大部分细节，流程会来到（**PipelineDraweeControllerBuilder.java**）：

```java
  @Override
  protected DataSource<CloseableReference<CloseableImage>> getDataSourceForRequest(
          ImageRequest imageRequest,
          Object callerContext,
          boolean bitmapCacheOnly) {
    if (bitmapCacheOnly) {
      return mImagePipeline.fetchImageFromBitmapCache(imageRequest, callerContext);
    } else {
      return mImagePipeline.fetchDecodedImage(imageRequest, callerContext);
    }
  }
```

这里就是开始图片拉取，转入到 **ImagePipeline** 核心流程。这里就是调用的 **ImagePipeline** 的 **fetchDecodeImage** 方法，从名字看，意思就是"获取一张decode（解码）的图片"，其代码（**ImagePipeline.java**）：

```java
  /**
   * Submits a request for execution and returns a DataSource representing the pending decoded
   * image(s).
   * <p>The returned DataSource must be closed once the client has finished with it.
   * @param imageRequest the request to submit
   * @return a DataSource representing the pending decoded image(s)
   */
  public DataSource<CloseableReference<CloseableImage>> fetchDecodedImage(
          ImageRequest imageRequest,
          Object callerContext) {
    try {
      Producer<CloseableReference<CloseableImage>> producerSequence =
              mProducerSequenceFactory.getDecodedImageProducerSequence(imageRequest);
      return submitFetchRequest(
              producerSequence,
              imageRequest,
              ImageRequest.RequestLevel.FULL_FETCH,
              callerContext);
    } catch (Exception exception) {
      return DataSources.immediateFailedDataSource(exception);
    }
  }
```

这里有两个主要的函数：**getDecodedImageProducerSequence** 和 **submitFetchRequest**

**getDecodedImageProducerSequence** 的返回值就是一个 **Producer\<CloseableReference\<CloseableImage\>\>**。该值作为参数，传到第二个函数 **submitFetchRequest** 中，先看 **submitFetchRequest**：

```java
  private <T> DataSource<CloseableReference<T>> submitFetchRequest(
          Producer<CloseableReference<T>> producerSequence,
          ImageRequest imageRequest,
          ImageRequest.RequestLevel lowestPermittedRequestLevelOnSubmit,
          Object callerContext) {
    try {
      ImageRequest.RequestLevel lowestPermittedRequestLevel =
              ImageRequest.RequestLevel.getMax(
                      imageRequest.getLowestPermittedRequestLevel(),
                      lowestPermittedRequestLevelOnSubmit);
      SettableProducerContext settableProducerContext = new SettableProducerContext(
              imageRequest,
              generateUniqueFutureId(),
              mRequestListener,
              callerContext,
              lowestPermittedRequestLevel,
      /* isPrefetch */ false,
              imageRequest.getProgressiveRenderingEnabled() ||
                      !UriUtil.isNetworkUri(imageRequest.getSourceUri()),
              imageRequest.getPriority());
      return CloseableProducerToDataSourceAdapter.create(
              producerSequence,
              settableProducerContext,
              mRequestListener);
    } catch (Exception exception) {
      return DataSources.immediateFailedDataSource(exception);
    }
  }
```

然后上面的create函数，就会一直到（**AbstractProducerToDataSourceAdapter.java**）：

```java
  protected AbstractProducerToDataSourceAdapter(
          Producer<T> producer,
          SettableProducerContext settableProducerContext,
          RequestListener requestListener) {
    mSettableProducerContext = settableProducerContext;
    mRequestListener = requestListener;
    mRequestListener.onRequestStart(
            settableProducerContext.getImageRequest(),
            mSettableProducerContext.getCallerContext(),
            mSettableProducerContext.getId(),
            mSettableProducerContext.isPrefetch());
    producer.produceResults(createConsumer(), settableProducerContext);
  }
```

到最后，**submitFetchRequest** 会调用到 **Producer#produceResults** 方法，而这个producer就是前面那个 **getDecodedImageProducerSequence** 方法产生的，所以回头看这个 **最最关键的地方**。

**getDecodedImageProducerSequence** 是 **ProducerSequenceFactory.java** 的方法：

```java
  /**
   * Returns a sequence that can be used for a request for a decoded image.
   *
   * @param imageRequest the request that will be submitted
   * @return the sequence that should be used to process the request
   */
  public Producer<CloseableReference<CloseableImage>> getDecodedImageProducerSequence(
          ImageRequest imageRequest) {
    Producer<CloseableReference<CloseableImage>> pipelineSequence =
            getBasicDecodedImageSequence(imageRequest);
    if (imageRequest.getPostprocessor() != null) {
      return getPostprocessorSequence(pipelineSequence);
    } else {
      return pipelineSequence;
    }
  }
```

从注释看，方法的意思就是返回一个用于请求decoded图片的sequence，而事实上，应该是返回一个Producer才对啊，

### 那为什么是强调是sequence Producer，而不是，仅仅就是一个Producer？

带着疑问继续看：

```java
private Producer<CloseableReference<CloseableImage>> getBasicDecodedImageSequence(
          ImageRequest imageRequest) {
    Preconditions.checkNotNull(imageRequest);

    Uri uri = imageRequest.getSourceUri();
    Preconditions.checkNotNull(uri, "Uri is null.");
    if (UriUtil.isNetworkUri(uri)) {
      return getNetworkFetchSequence();
    } else if (UriUtil.isLocalFileUri(uri)) {
      if (MediaUtils.isVideo(MediaUtils.extractMime(uri.getPath()))) {
        return getLocalVideoFileFetchSequence();
      } else {
        return getLocalImageFileFetchSequence();
      }
    } else if (UriUtil.isLocalContentUri(uri)) {
      return getLocalContentUriFetchSequence();
    } else if (UriUtil.isLocalAssetUri(uri)) {
      return getLocalAssetFetchSequence();
    } else if (UriUtil.isLocalResourceUri(uri)) {
      return getLocalResourceFetchSequence();
    } else if (UriUtil.isDataUri(uri)) {
      return getDataFetchSequence();
    } else {
      String uriString = uri.toString();
      if (uriString.length() > 30) {
        uriString = uriString.substring(0, 30) + "...";
      }
      throw new RuntimeException("Unsupported uri scheme! Uri is: " + uriString);
    }
  }
```

看代码可知道，就是根据 **ImageRequest** 的 *Uri*，选择一个sequence Producer，我们这里假设是网络请求图片，所以选择的是 **getNetworkFetchSequence**，*它也是返回一个Producer（可粗略看）*：

```java
  /**
   * swallow result if prefetch -> bitmap cache get ->
   * background thread hand-off -> multiplex -> bitmap cache -> decode -> multiplex ->
   * encoded cache -> disk cache -> (webp transcode) -> network fetch.
   */
  private synchronized Producer<CloseableReference<CloseableImage>> getNetworkFetchSequence() {
    if (mNetworkFetchSequence == null) {
      mNetworkFetchSequence =
              newBitmapCacheGetToDecodeSequence(getCommonNetworkFetchToEncodedMemorySequence());
    }
    return mNetworkFetchSequence;
  }
```

先看红色代码，**getCommonNetworkFetchToEncodedMemorySequence**，*它也是返回一个Producer（可粗略看）*：

```java
  /**
   * multiplex -> encoded cache -> disk cache -> (webp transcode) -> network fetch.
   */
  private synchronized Producer<EncodedImage> getCommonNetworkFetchToEncodedMemorySequence() {
    if (mCommonNetworkFetchToEncodedMemorySequence == null) {
      Producer<EncodedImage> inputProducer =
              newEncodedCacheMultiplexToTranscodeSequence(
                      mProducerFactory.newNetworkFetchProducer(mNetworkFetcher));
      mCommonNetworkFetchToEncodedMemorySequence =
              ProducerFactory.newAddImageTransformMetaDataProducer(inputProducer);

      if (mResizeAndRotateEnabledForNetwork && !mDownsampleEnabled) {
        mCommonNetworkFetchToEncodedMemorySequence =
                mProducerFactory.newResizeAndRotateProducer(
                        mCommonNetworkFetchToEncodedMemorySequence);
      }
    }
    return mCommonNetworkFetchToEncodedMemorySequence;
  }
```

再看，**newEncodedCacheMultiplexToTranscodeSequence**，*它也是返回一个Producer（可粗略看）*：

```java
  /**
   * encoded cache multiplex -> encoded cache -> (disk cache) -> (webp transcode)
   * @param inputProducer producer providing the input to the transcode
   * @return encoded cache multiplex to webp transcode sequence
   */
  private Producer<EncodedImage> newEncodedCacheMultiplexToTranscodeSequence(
          Producer<EncodedImage> inputProducer) {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.JELLY_BEAN_MR2) {
      inputProducer = mProducerFactory.newWebpTranscodeProducer(inputProducer);
    }
    inputProducer = mProducerFactory.newDiskCacheProducer(inputProducer);
    EncodedMemoryCacheProducer encodedMemoryCacheProducer =
            mProducerFactory.newEncodedMemoryCacheProducer(inputProducer);
    return mProducerFactory.newEncodedCacheKeyMultiplexProducer(encodedMemoryCacheProducer);
  }
```

选其中一个函数看，newDiskCacheProducer，*它也是返回一个Producer（可粗略看）*：

```java
  public DiskCacheProducer newDiskCacheProducer(
          Producer<EncodedImage> inputProducer) {
    return new DiskCacheProducer(
            mDefaultBufferedDiskCache,
            mSmallImageBufferedDiskCache,
            mCacheKeyFactory,
            inputProducer);
  }
```

*好了，到此为止（列出的函数足够多了，晕~~~）*

其实上面，一连串几个函数，如果有细心的留意，它们有一个特点，就是，**（每一个函数）都以 （上一个函数）产生的Producer作为参数进行传递**。

这样的设计，是不是有似曾相识的感觉，看下面的代码应该就能够了解得更深：

```java
FileInputStream fileInputStream = new FileInputStream("/test.txt");

InputStreamReader inputStreamReader = new InputStreamReader(fileInputStream);

BufferedReader bufferedReader = new BufferedReader(inputSteamReader);
```

很熟悉了吧，可以把sequence Producer就看成是上面这样的一个逻辑~~~

### DiskCacheProducer 分析

那么这样做的作用是什么？我们选一个简单Producer来分析，就以 **DiskCacheProducer** 为例：

```java
 public DiskCacheProducer(
          BufferedDiskCache defaultBufferedDiskCache,
          BufferedDiskCache smallImageBufferedDiskCache,
          CacheKeyFactory cacheKeyFactory,
          Producer<EncodedImage> inputProducer) {
    mDefaultBufferedDiskCache = defaultBufferedDiskCache;
    mSmallImageBufferedDiskCache = smallImageBufferedDiskCache;
    mCacheKeyFactory = cacheKeyFactory;
    mInputProducer = inputProducer;
  }

  public void produceResults(
          final Consumer<EncodedImage> consumer,
          final ProducerContext producerContext) {
    ImageRequest imageRequest = producerContext.getImageRequest();
    //如果diskcache disabled的话，那么直接执行maybeStartInputProducer
    if (!imageRequest.isDiskCacheEnabled()) {
      maybeStartInputProducer(consumer, consumer, producerContext);
      return;
    }

    final ProducerListener listener = producerContext.getListener();
    final String requestId = producerContext.getId();
    listener.onProducerStart(requestId, PRODUCER_NAME);

    final CacheKey cacheKey = mCacheKeyFactory.getEncodedCacheKey(imageRequest);
    final BufferedDiskCache cache =
            imageRequest.getImageType() == ImageRequest.ImageType.SMALL
                    ? mSmallImageBufferedDiskCache
                    : mDefaultBufferedDiskCache;
    Continuation<EncodedImage, Void> continuation = new Continuation<EncodedImage, Void>() {
      //回调
      @Override
      public Void then(Task<EncodedImage> task)
              throws Exception {
        //根据task是canceled，fault等状态决定如何执行
        if (task.isCancelled() ||
                (task.isFaulted() && task.getError() instanceof CancellationException)) {
          listener.onProducerFinishWithCancellation(requestId, PRODUCER_NAME, null);
          consumer.onCancellation();
        } else if (task.isFaulted()) {
          listener.onProducerFinishWithFailure(requestId, PRODUCER_NAME, task.getError(), null);
          //出错了，就调用maybeStartInputProducer
          maybeStartInputProducer(
                  consumer,
                  new DiskCacheConsumer(consumer, cache, cacheKey),
                  producerContext);
        } else {
          EncodedImage cachedReference = task.getResult();
          if (cachedReference != null) {
            listener.onProducerFinishWithSuccess(
                    requestId,
                    PRODUCER_NAME,
                    getExtraMap(listener, requestId, true));
            consumer.onProgressUpdate(1);
            consumer.onNewResult(cachedReference, true);
            cachedReference.close();
          } else {
            //没有结果，就调用maybeStartInputProducer
            listener.onProducerFinishWithSuccess(
                    requestId,
                    PRODUCER_NAME,
                    getExtraMap(listener, requestId, false));
            maybeStartInputProducer(
                    consumer,
                    new DiskCacheConsumer(consumer, cache, cacheKey),
                    producerContext);
          }
        }
        return null;
      }
    };

    AtomicBoolean isCancelled = new AtomicBoolean(false);
    final Task<EncodedImage> diskCacheLookupTask =
            cache.get(cacheKey, isCancelled);
    //执行task，task其实就是从缓存中取结果，执行后，前面的continuation就会被回调
    diskCacheLookupTask.continueWith(continuation);
    subscribeTaskForRequestCancellation(isCancelled, producerContext);
  }

  //调用mInputProducer的produceResults
  private void maybeStartInputProducer(
          Consumer<EncodedImage> consumerOfDiskCacheProducer,
          Consumer<EncodedImage> consumerOfInputProducer,
          ProducerContext producerContext) {
    if (producerContext.getLowestPermittedRequestLevel().getValue() >=
            ImageRequest.RequestLevel.DISK_CACHE.getValue()) {
      consumerOfDiskCacheProducer.onNewResult(null, true);
      return;
    }

    mInputProducer.produceResults(consumerOfInputProducer, producerContext);
  }
```

从前面知道，当开始拉取图片的时候，**Producer#produceResult** 开始执行，注释标出了关键的步骤，从这些步骤可以看出，其实 **DiskCacheProducer** 拉取图片时，做的任务大概就是：**先看Diskcache中是否有缓存的图片，如果有，就直接返回缓存，如果没有，就用 inputProducer 来处理**。

然后，**inputProducer** 处理完结果会怎样呢？它处理的结果会在 **consumer** 中接收到，上面的例子代码对应的就是 **DiskCacheConsumer**：

```java
  /**
   * Consumer that consumes results from next producer in the sequence.
   *
   * <p>The consumer puts the last result received into disk cache, and passes all results (success
   * or failure) down to the next consumer.
   */
  private class DiskCacheConsumer extends DelegatingConsumer<EncodedImage, EncodedImage> {

    private final BufferedDiskCache mCache;
    private final CacheKey mCacheKey;

    private DiskCacheConsumer(
            final Consumer<EncodedImage> consumer,
            final BufferedDiskCache cache,
            final CacheKey cacheKey) {
      super(consumer);
      mCache = cache;
      mCacheKey = cacheKey;
    }
    //inputProducer的结果会从这里返回，即newResult
    @Override
    public void onNewResultImpl(EncodedImage newResult, boolean isLast) {
      //返回的结果加入cache中
      if (newResult != null && isLast) {
        mCache.put(mCacheKey, newResult);
      }
      //回调上一层procducer传进来的consumer
      getConsumer().onNewResult(newResult, isLast);
    }
  }
```

### Sequence Producer 的本质

到这里，应该就大概明白这个sequence Producer的作用了，所谓sequence Producer，其实就是 **一层层的Producer不断的嵌套连接起来，完成同一个任务，而每一个Producer都相互独立，完成各自任务；同时，Producer间产生的结果，也会相互传递，互为表里**。可以称其为"Producer链"，但是"Producer链"本身被抽象成一个Producer，那么对于上层来看，这样一个复杂的处理逻辑就被隐藏起来了，变得更加容易理解。

sequence Producer功能极其强大，不同的Producer的组合，产生了很多不同的效果，对于代码的扩展性，可复用性和灵活性都有很大好处。

### MultiplexProducer 分析

例如，**MultiplexProducer**：

注释：

```java
/**
* Producer for combining multiple identical requests into a single request.
*
* <p>Requests using the same key will be combined into a single request. This request is only
* cancelled when all underlying requests are cancelled, and returns values to all underlying
* consumers. If the request has already return one or more results but has not finished, then
* any requests with the same key will have the most recent result returned to them immediately.
*
* @param <K> type of the key
* @param <T> type of the closeable reference result that is returned to this producer
*/
@ThreadSafe
public abstract class MultiplexProducer<K, T extends Closeable> implements Producer<T>
```

理解为，多路复用Producer（什么鬼东西？），其实就是将相同的任务合并为一个，例如相同url的重复请求，如何做到的，关键代码：

```java
  @Override
  public void produceResults(Consumer<T> consumer, ProducerContext context) {
    K key = getKey(context);
    Multiplexer multiplexer;
    boolean createdNewMultiplexer;
    // We do want to limit scope of this lock to guard only accesses to mMultiplexers map.
    // However what we would like to do here is to atomically lookup mMultiplexers, add new
    // consumer to consumers set associated with the map's entry and call consumer's callback with
    // last intermediate result. We should not do all of those things under this lock.
    do {
      createdNewMultiplexer = false;
      synchronized (this) {
        //根据key获得多路复用器，当缓存没有的时候，才create一个，不然直接忽略
        multiplexer = getExistingMultiplexer(key);
        if (multiplexer == null) {
          multiplexer = createAndPutNewMultiplexer(key);
          createdNewMultiplexer = true;
        }
      }
    // addNewConsumer may call consumer's onNewResult method immediately. For this reason
    // we release "this" lock. If multiplexer is removed from mMultiplexers in the meantime,
    // which is not very probable, then addNewConsumer will fail and we will be able to retry.
    } while (!multiplexer.addNewConsumer(consumer, context));
    //如果前面没有创建，也就是存在缓存的多路复用器，那么就不会调用startInputProducerIfHasAttachedConsumers，然后inputProducer就不起作用了，这样，就起到合并请求的作用

    if (createdNewMultiplexer) {
      multiplexer.startInputProducerIfHasAttachedConsumers();
    }
  }
```

不同的功能Producer还有很多，例如对图片进行resize和rotate的 **ResizeAndRotateProducer**，异步执行任务的 **ThreadHandoffProducer** 等等，如此灵活的实现，得益于sequence Factory这种设计。

## 总结

ImagePipeline的核心Producer，通过sequence的形式，很好的串联了整个图片网络读取，缓存，bitmap处理等流程，通过优秀的设计，保证的代码 **高扩展性**，**高可复用性** 和 **高灵活性**。

这种设计刚好对应就是"**pipeline**"这个词的含义，就如现代的pipelined CPU一样，把对指令的处理，拆分成多个stage，同时输入输出相互依赖和协作，共同完成一个任务。

~~~文卒~~~
