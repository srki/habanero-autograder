package edu.rice.comp322;

import junit.framework.*;

import static edu.rice.hj.Module0.launchHabaneroApp;
import edu.rice.hj.api.SuspendableException;

public class CryptPerformanceTest extends TestCase {

    private void checkCorrectness(int size) throws SuspendableException {
      final Crypt crypt = new Crypt(size);
      crypt.Do();
      // crypt.validate returns true on error
      assertFalse("Test failure for size=" + size, crypt.validate());
    }

    public void testCorrectness1(){
        launchHabaneroApp(() -> {
          checkCorrectness(2000000);
        });
    }

    public void testCorrectness2(){
        launchHabaneroApp(() -> {
          checkCorrectness(50000000);
        });
    }

    public void testCorrectness3(){
        launchHabaneroApp(() -> {
          checkCorrectness(80000000);
        });
    }
}
